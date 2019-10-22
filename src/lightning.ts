import {
  CallCredentials,
  Client,
  ClientDuplexStream,
  ClientReadableStream,
  credentials,
  makeClientConstructor,
  Metadata
} from '@grpc/grpc-js'
import { createHash } from 'crypto'
import { util } from 'protobufjs'
import { lnrpc } from '../generated/rpc'

/** Create a generic gRPC client */

export type GrpcClient = Client

export interface GrpcConnectionOpts {
  /** TLS cert as a Base64-encoded string or Buffer (e.g. using `fs.readFile`) */
  tlsCert: string | Buffer

  /** LND macaroon as a Base64-encoded string or Buffer (e.g. using `fs.readFile`) */
  macaroon: string | Buffer

  /** IP address or host of the Lightning node */
  hostname?: string

  /** Port of LND gRPC server */
  port?: string | number
}

export const createGrpcClient = ({
  tlsCert,
  macaroon,
  hostname = 'localhost',
  port = 10009
}: GrpcConnectionOpts): GrpcClient => {
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

  let macaroonCreds: CallCredentials
  try {
    const metadata = new Metadata()
    metadata.add('macaroon', macaroon.toString('hex'))
    const metadataGenerator = (_: any, callback: any) => {
      callback(null, metadata)
    }

    macaroonCreds = CallCredentials.createFromMetadataGenerator(
      metadataGenerator
    )
  } catch (err) {
    throw new Error(`Macaroon is not properly formatted: ${err.message}`)
  }

  port = typeof port === 'string' ? parseInt(port, 10) : port
  const address = hostname + ':' + port
  const tlsCreds = credentials.createSsl(tlsCert)
  const channelCredentials = credentials.combineChannelCredentials(
    tlsCreds,
    macaroonCreds
  )

  const Client = makeClientConstructor({}, '')
  return new Client(address, channelCredentials)
}

/** Wrap a gRPC client in a Lightning RPC service with typed methods and messages */

export type LndService = lnrpc.Lightning

export const createLnrpc = (client: GrpcClient) =>
  new lnrpc.Lightning({
    unaryCall(method, requestData, callback) {
      client.makeUnaryRequest(
        getMethodPath(method.name),
        arg => Buffer.from(arg),
        arg => Buffer.from(arg),
        requestData,
        callback
      )
    },
    serverStreamCall(method, requestData, decode) {
      return (client.makeServerStreamRequest(
        getMethodPath(method.name),
        arg => Buffer.from(arg),
        decode,
        requestData
      ) as unknown) as util.EventEmitter
    },
    clientStreamCall(method, encode, decode) {
      return (client.makeClientStreamRequest(
        getMethodPath(method.name),
        arg => Buffer.from(encode(arg)),
        decode,
        () => {
          return
        }
      ) as unknown) as util.EventEmitter
    },
    bidiStreamCall(method, encode, decode) {
      return (client.makeBidiStreamRequest(
        getMethodPath(method.name),
        arg => Buffer.from(encode(arg)),
        decode
      ) as unknown) as util.EventEmitter
    }
  })

const getMethodPath = (methodName: string) => `/lnrpc.Lightning/${methodName}`

/* Create streams to send outgoing and handle incoming invoices */

export type InvoiceStream = ClientReadableStream<lnrpc.IInvoice>

export const createInvoiceStream = (lightning: LndService): InvoiceStream =>
  lightning.subscribeInvoices({
    addIndex: 0,
    settleIndex: 0
  })

export type PaymentStream = ClientDuplexStream<
  lnrpc.SendRequest,
  lnrpc.SendResponse
>

export const createPaymentStream = (lightning: LndService): PaymentStream =>
  lightning.sendPayment()

interface PayInvoiceRequest extends lnrpc.ISendRequest {
  paymentHash: Buffer
}

/**
 * Pay a given request using a bidirectional streaming RPC.
 * Reject if it failed to pay the invoice
 */
export const payInvoice = async (
  paymentStream: PaymentStream,
  request: PayInvoiceRequest
) => {
  const didSerialize = paymentStream.write(new lnrpc.SendRequest(request))
  if (!didSerialize) {
    throw new Error(`failed to serialize outgoing payment`)
  }

  /**
   * Since it's a stream, there's no request-response matching.
   * Disregard messages that don't correspond to this invoice
   */
  await new Promise((resolve, reject) => {
    const handler = (data: lnrpc.SendResponse) => {
      const isThisInvoice = request.paymentHash.equals(data.paymentHash)
      if (!isThisInvoice) {
        return
      }

      // The invoice was not paid and it's safe to undo the balance update
      const error = data.paymentError
      if (error) {
        paymentStream.removeListener('data', handler)
        return reject(`error sending payment: ${error}`)
      }

      paymentStream.removeListener('data', handler)
      resolve()
    }

    paymentStream.on('data', handler)
  })
}

/** Ensure that this instance is peered with the given Lightning node, throw if not */
export const connectPeer = async (
  lightning: LndService,
  peerAddress: string
) => {
  const [peerIdentityPubkey, peerHost] = peerAddress.split('@')

  /**
   * LND throws if it failed to connect:
   * https://github.com/lightningnetwork/lnd/blob/f55e81a2d422d34181ea2a6579e5fcc0296386c2/rpcserver.go#L952
   */
  await lightning
    .connectPeer({
      addr: {
        pubkey: peerIdentityPubkey,
        host: peerHost
      }
    })
    .catch((err: { details: string }) => {
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

export const sha256 = (preimage: string | Uint8Array | Buffer) =>
  createHash('sha256')
    .update(preimage)
    .digest()
