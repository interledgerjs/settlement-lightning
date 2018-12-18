import BigNumber from 'bignumber.js'
import { createHash } from 'crypto'
import * as grpc from 'grpc'
import pify = require('pify')
import { LightningClient } from '../../generated/rpc_grpc_pb'
import {
  Channel,
  ConnectPeerRequest,
  Invoice,
  InvoiceSubscription,
  LightningAddress,
  ListChannelsRequest,
  SendRequest,
  SendResponse
} from '../../generated/rpc_pb'

export const sha256 = (preimage: string | Uint8Array | Buffer) =>
  createHash('sha256')
    .update(preimage)
    .digest()

export interface LndOpts {
  /** TLS cert as a Base64-encoded string or Buffer (e.g. using `fs.readFile`) */
  tlsCert: string | Buffer

  /** LND macaroon as Base64-encoded string or Buffer (e.g. using `fs.readFile`) */
  macaroon: string | Buffer

  /** IP address of the Lightning node */
  lndHost: string

  /** Port of LND gRPC server */
  grpcPort?: number
}

export interface LightningService {
  /** Streaming notifications of paid invoices from server -> client */
  invoiceStream: grpc.ClientReadableStream<Invoice>

  /** Wait for the connection/channel to the LND node to be fully established */
  waitForReady: () => Promise<void>

  /** Add a new invoice to the LND node and return the payment request */
  createPaymentRequest: () => Promise<string>

  /**
   * Pay a given request using a bidirectional streaming RPC.
   * Throw if it failed to pay the invoice
   */
  payInvoice: (
    paymentRequest: string,
    paymentHash: string,
    amount: BigNumber
  ) => Promise<void>

  /** Ensure that this instance is peered with the given Lightning node, throw if not */
  connectPeer: (peerIdentityPubkey: string, peerHost: string) => Promise<void>

  /** Fetch all open channels that the node is a participant in */
  getChannels: () => Promise<Channel[]>

  /** Close the gRPC channel & connection to LND node */
  disconnect: () => void
}

export const connectLnd = ({
  tlsCert,
  macaroon,
  lndHost,
  grpcPort = 10009
}: LndOpts): LightningService => {
  /**
   * Required for SSL handshake with LND
   * https://grpc.io/grpc/core/md_doc_environment_variables.html
   */
  if (!process.env.GRPC_SSL_CIPHER_SUITES) {
    process.env.GRPC_SSL_CIPHER_SUITES = 'HIGH+ECDSA'
  }

  if (typeof tlsCert === 'string') {
    tlsCert = Buffer.from(tlsCert, 'base64')
  }

  if (typeof macaroon === 'string') {
    macaroon = Buffer.from(macaroon, 'base64')
  }

  let macaroonCreds: grpc.CallCredentials
  try {
    const metadata = new grpc.Metadata()
    metadata.add('macaroon', macaroon.toString('hex'))
    macaroonCreds = grpc.credentials.createFromMetadataGenerator(
      (_, callback) => {
        callback(null, metadata)
      }
    )
  } catch (err) {
    throw new Error(`Macaroon is not properly formatted: ${err.message}`)
  }

  const address = lndHost + ':' + grpcPort
  const tlsCreds = grpc.credentials.createSsl(tlsCert)
  const credentials = grpc.credentials.combineChannelCredentials(
    tlsCreds,
    macaroonCreds
  )

  const lightning = new LightningClient(address, credentials)
  const pLightning = pify(lightning) // Promisify the Lightning client: sayonara callbacks! ;)

  const paymentStream = lightning.sendPayment()

  const requestInvoiceSub = new InvoiceSubscription()
  requestInvoiceSub.setAddIndex(0)
  requestInvoiceSub.setSettleIndex(0)
  const invoiceStream = lightning.subscribeInvoices(requestInvoiceSub)

  /**
   * Define the exported API
   */

  return {
    invoiceStream,

    async waitForReady(): Promise<void> {
      const deadline = Date.now() + 10000
      await pLightning.waitForReady(deadline)
    },

    async createPaymentRequest() {
      const invoice = await pLightning.addInvoice(new Invoice())
      return invoice.getPaymentRequest()
    },

    async payInvoice(
      paymentRequest: string,
      paymentHash: string,
      amount: BigNumber
    ) {
      const request = new SendRequest()
      request.setPaymentRequest(paymentRequest)
      request.setAmt(amount.toNumber())

      const didSerialize = paymentStream.write(request)
      if (!didSerialize) {
        throw new Error(`failed to serialize outgoing payment`)
      }

      await new Promise(resolve => {
        const handler = (data: SendResponse) => {
          let somePaymentHash = data.getPaymentHash()
          /**
           * Returning the `payment_hash` in the response was merged into
           * lnd@master on 12/10/18, so many nodes may not support it yet:
           * https://github.com/lightningnetwork/lnd/pull/2033
           *
           * (if not, fallback to generating the hash from the preimage)
           */
          if (typeof somePaymentHash === 'string') {
            somePaymentHash = sha256(data.getPaymentPreimage())
          }
          /**
           * Since it's a stream, there's no request-response matching.
           * Disregard a message if it doesn't correspond to this invoice
           */
          const isThisInvoice =
            paymentHash === Buffer.from(somePaymentHash).toString('hex')
          if (!isThisInvoice) {
            return
          }

          // The invoice was not paid and it's safe to undo the balance update
          const error = data.getPaymentError()
          if (error) {
            throw new Error(`error sending payment: ${error}`)
          }

          paymentStream.removeListener('data', handler)
          resolve()
        }

        paymentStream.on('data', handler)
      })
    },

    async connectPeer(
      peerIdentityPubkey: string,
      peerHost: string
    ): Promise<void> {
      const peerAddress = new LightningAddress()
      peerAddress.setHost(peerHost)
      peerAddress.setPubkey(peerIdentityPubkey)

      const request = new ConnectPeerRequest()
      request.setAddr(peerAddress)

      /**
       * LND throws if it failed to connect:
       * https://github.com/lightningnetwork/lnd/blob/f55e81a2d422d34181ea2a6579e5fcc0296386c2/rpcserver.go#L952
       */
      await pLightning.connectPeer(request).catch(err => {
        /**
         * Don't throw if we're already connected, akin to:
         * https://github.com/lightningnetwork/lnd/blob/8c5d6842c2ea7234512d3fb0ddc69d51c8026c74/lntest/harness.go#L428
         */
        const alreadyConnected = err.details.includes(
          'already connected to peer'
        )
        if (!alreadyConnected) {
          throw err
        }
      })
    },

    async getChannels(): Promise<Channel[]> {
      return (await pLightning.listChannels(
        new ListChannelsRequest()
      )).getChannelsList()
    },

    disconnect() {
      return lightning.close()
    }
  }
}
