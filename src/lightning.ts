import BigNumber from 'bignumber.js'
import { createHash } from 'crypto'
import * as grpc from 'grpc'
import pify from 'pify'
import { PromisifySome } from './types/promisify'
import { LightningClient } from '../generated/rpc_grpc_pb'
import {
  ConnectPeerRequest,
  Invoice,
  InvoiceSubscription,
  LightningAddress,
  SendRequest,
  SendResponse
} from '../generated/rpc_pb'

// Re-export all compiled gRPC message types
export * from '../generated/rpc_pb'

export interface LndOpts {
  /** TLS cert as a Base64-encoded string or Buffer (e.g. using `fs.readFile`) */
  tlsCert: string | Buffer
  /** LND macaroon as a Base64-encoded string or Buffer (e.g. using `fs.readFile`) */
  macaroon: string | Buffer
  /** IP address of the Lightning node */
  hostname: string
  /** Port of LND gRPC server */
  grpcPort?: number
}

export type LndService = PromisifySome<
  LightningClient,
  'sendPayment' | 'subscribeInvoices' | 'close'
>

export const connectLnd = ({
  tlsCert,
  macaroon,
  hostname,
  grpcPort = 10009
}: LndOpts): LndService => {
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

  const address = hostname + ':' + grpcPort
  const tlsCreds = grpc.credentials.createSsl(tlsCert)
  const credentials = grpc.credentials.combineChannelCredentials(
    tlsCreds,
    macaroonCreds
  )

  // Promisify the Lightning client: sayonara callbacks! ;)
  return pify(new LightningClient(address, credentials), {
    exclude: ['sendPayment', 'subscribeInvoices', 'close']
  })
}

/* Create streams to send outgoing and handle incoming invoices */

export type InvoiceStream = grpc.ClientReadableStream<Invoice>

export const createInvoiceStream = (lightning: LndService): InvoiceStream => {
  const requestInvoiceSub = new InvoiceSubscription()
  requestInvoiceSub.setAddIndex(0)
  requestInvoiceSub.setSettleIndex(0)
  return lightning.subscribeInvoices(requestInvoiceSub)
}

export const createPaymentRequest = async (lightning: LndService) =>
  (await lightning.addInvoice(new Invoice())).getPaymentRequest()

export type PaymentStream = grpc.ClientDuplexStream<SendRequest, SendResponse>

export const createPaymentStream = (lightning: LndService): PaymentStream =>
  lightning.sendPayment()

/**
 * Pay a given request using a bidirectional streaming RPC.
 * Throw if it failed to pay the invoice
 */
export const payInvoice = async (
  paymentStream: PaymentStream,
  paymentRequest: string,
  paymentHash: string,
  amount: BigNumber
) => {
  const request = new SendRequest()
  request.setPaymentRequest(paymentRequest)
  request.setAmt(amount.toNumber())

  const didSerialize = paymentStream.write(request)
  if (!didSerialize) {
    throw new Error(`failed to serialize outgoing payment`)
  }

  /**
   * Since it's a stream, there's no request-response matching.
   * Disregard messages that don't correspond to this invoice
   */
  await new Promise((resolve, reject) => {
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

      const isThisInvoice =
        paymentHash === Buffer.from(somePaymentHash).toString('hex')
      if (!isThisInvoice) {
        return
      }

      // The invoice was not paid and it's safe to undo the balance update
      const error = data.getPaymentError()
      if (error) {
        paymentStream.off('data', handler)
        return reject(`error sending payment: ${error}`)
      }

      paymentStream.off('data', handler)
      resolve()
    }

    paymentStream.on('data', handler)
  })
}

/** Wait for the connection/channel to the LND node to be fully established */
export const waitForReady = (lightning: LndService) =>
  lightning.waitForReady(Date.now() + 10000)

/** Ensure that this instance is peered with the given Lightning node, throw if not */
export const connectPeer = (lightning: LndService) => async (
  /** Identity public key of the Lightning node to peer with */
  peerIdentityPubkey: string,
  /** Network location of the Lightning node to peer with, e.g. `69.69.69.69:1337` or `localhost:10011` */
  peerHost: string
) => {
  const peerAddress = new LightningAddress()
  peerAddress.setHost(peerHost)
  peerAddress.setPubkey(peerIdentityPubkey)

  const request = new ConnectPeerRequest()
  request.setAddr(peerAddress)

  /**
   * LND throws if it failed to connect:
   * https://github.com/lightningnetwork/lnd/blob/f55e81a2d422d34181ea2a6579e5fcc0296386c2/rpcserver.go#L952
   */
  await lightning.connectPeer(request).catch((err: { details: string }) => {
    /**
     * Don't throw if we're already connected, akin to:
     * https://github.com/lightningnetwork/lnd/blob/8c5d6842c2ea7234512d3fb0ddc69d51c8026c74/lntest/harness.go#L428
     */
    const alreadyConnected = err.details.includes('already connected to peer')
    if (!alreadyConnected) {
      throw err
    }
  })
}

const sha256 = (preimage: string | Uint8Array | Buffer) =>
  createHash('sha256')
    .update(preimage)
    .digest()
