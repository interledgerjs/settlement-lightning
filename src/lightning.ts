import { credentials } from '@grpc/grpc-js'
import {
  ClientDuplexStream,
  ClientReadableStream
} from '@grpc/grpc-js/build/src/call'
import {
  CallCredentials,
  CallMetadataGenerator
} from '@grpc/grpc-js/build/src/call-credentials'
import {
  makeClientConstructor,
  ServiceClient
} from '@grpc/grpc-js/build/src/make-client'
import { Metadata } from '@grpc/grpc-js/build/src/metadata'
import BigNumber from 'bignumber.js'
import { util } from 'protobufjs'
import { lnrpc } from '../generated/rpc'
import { createHash } from 'crypto'

/** Re-export all compiled gRPC message types */
export * from '../generated/rpc'

/** Create a generic gRPC client */

export interface GrpcConnectionOpts {
  /** TLS cert as a Base64-encoded string or Buffer (e.g. using `fs.readFile`) */
  tlsCert: string | Buffer
  /** LND macaroon as a Base64-encoded string or Buffer (e.g. using `fs.readFile`) */
  macaroon: string | Buffer
  /** IP address of the Lightning node */
  hostname: string
  /** Port of LND gRPC server */
  grpcPort?: number
}

export const createGrpcClient = ({
  tlsCert,
  macaroon,
  hostname,
  grpcPort = 10009
}: GrpcConnectionOpts): ServiceClient => {
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
    const metadataGenerator: CallMetadataGenerator = (_, callback) => {
      callback(null, metadata)
    }

    macaroonCreds = CallCredentials.createFromMetadataGenerator(
      metadataGenerator
    )
  } catch (err) {
    throw new Error(`Macaroon is not properly formatted: ${err.message}`)
  }

  const address = hostname + ':' + grpcPort
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

export const createLnrpc = (client: ServiceClient) =>
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

export const createPaymentRequest = async (lightning: LndService) =>
  (await lightning.addInvoice({})).paymentRequest

export type PaymentStream = ClientDuplexStream<
  lnrpc.SendRequest,
  lnrpc.SendResponse
>

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
  const didSerialize = paymentStream.write(
    new lnrpc.SendRequest({
      amt: amount.toNumber(),
      paymentRequest
    })
  )
  if (!didSerialize) {
    throw new Error(`failed to serialize outgoing payment`)
  }

  /**
   * Since it's a stream, there's no request-response matching.
   * Disregard messages that don't correspond to this invoice
   */
  await new Promise((resolve, reject) => {
    const handler = (data: lnrpc.SendResponse) => {
      let somePaymentHash = data.paymentHash
      /**
       * Returning the `payment_hash` in the response was merged into
       * lnd@master on 12/10/18, so many nodes may not support it yet:
       * https://github.com/lightningnetwork/lnd/pull/2033
       *
       * (if not, fallback to generating the hash from the preimage)
       */
      if (!somePaymentHash) {
        somePaymentHash = sha256(data.paymentPreimage)
      }

      const isThisInvoice =
        somePaymentHash &&
        paymentHash === Buffer.from(somePaymentHash).toString('hex')
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
export const connectPeer = (lightning: LndService) => async (
  /** Identity public key of the Lightning node to peer with */
  peerIdentityPubkey: string,
  /** Network location of the Lightning node to peer with, e.g. `69.69.69.69:1337` or `localhost:10011` */
  peerHost: string
) => {
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

const sha256 = (preimage: string | Uint8Array | Buffer) =>
  createHash('sha256')
    .update(preimage)
    .digest()
