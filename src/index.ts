import { waitForClientReady } from '@grpc/grpc-js'
import BigNumber from 'bignumber.js'
import { randomBytes } from 'crypto'
import debug from 'debug'
import { AccountServices, SettlementEngine } from 'ilp-settlement-core'
import { promisify } from 'util'
import { lnrpc } from '../generated/rpc'
import {
  createGrpcClient,
  createInvoiceStream,
  createLnrpc,
  createPaymentStream,
  GrpcConnectionOpts,
  payInvoice,
  sha256,
  connectPeer
} from './lightning'
import { isPeeringRequestMessage, isPaymentPreimageMessage } from './messages'

const log = debug('settlement-lightning')

const SEND_PAYMENT_FINAL_CLTV_DELTA = 144 // Approximately 1 day @ 10 minutes / block

export type LightningEngineConfig = GrpcConnectionOpts

export interface LightningEngine extends SettlementEngine {
  setupAccount(accountId: string): Promise<void>
  sharePeeringInfo(accountId: string): Promise<string | undefined>
  handleMessage(accountId: string, message: any): Promise<any>
  disconnect(): Promise<void>
}

export type ConnectLightningEngine = (
  services: AccountServices
) => Promise<LightningEngine>

export const createEngine = (
  config: LightningEngineConfig
): ConnectLightningEngine => async ({ sendMessage, creditSettlement }) => {
  const grpcClient = createGrpcClient(config)
  const lightningClient = createLnrpc(grpcClient)

  await promisify(waitForClientReady)(grpcClient, Date.now() + 10000)
  log('Connected to LND gRPC server')

  /**
   * Fetch public key & host for peering directly from LND
   * Lightning address: [identityPubKey]@[hostname]:[port]
   */
  const { uris } = await lightningClient.getInfo({})
  const lightningAddress = uris[0]
  const peeringResponse = {
    type: 'peeringRequest',
    lightningAddress
  }
  log('Fetched our own Lightning address: %s', lightningAddress)

  /*
   * Create the streams after the connection has been established
   * (otherwise if the credentials turn out to be invalid, throws odd error messages)
   */
  const paymentStream = createPaymentStream(lightningClient)
  const invoiceStream = createInvoiceStream(lightningClient)

  // Keeping peer public keys in memory adds a minor amount of latency when either SE restarts
  const accountToPubkey = new Map<string, string>() // Mapping of account ID -> destination public key
  const paymentToAccount = new Map<string, string>() // Mapping of payment preimage -> account ID

  // Credit incoming payments to the correct account
  invoiceStream.on(
    'data',
    ({ amtPaidSat, settled, rPreimage }: lnrpc.IInvoice) => {
      if (!amtPaidSat || !settled || !rPreimage) {
        return
      }

      const amountBtc = new BigNumber(amtPaidSat.toString()).shiftedBy(-8)
      const preimageHex = Buffer.from(rPreimage).toString('hex')
      const accountId = paymentToAccount.get(preimageHex)
      if (!accountId) {
        log(
          'Received incoming Lightning payment from unknown account: preimage=%s sat=%d',
          preimageHex,
          amtPaidSat
        )
        return
      }

      // Garbage collect the preimage, since the sender shouldn't reuse it
      paymentToAccount.delete(preimageHex)

      log(
        'Received incoming Lightning payment: account=%s btc=%s',
        accountId,
        amountBtc
      )
      creditSettlement(accountId, amountBtc)
    }
  )

  const self: LightningEngine = {
    async setupAccount(accountId) {
      await this.sharePeeringInfo(accountId)
    },

    /**
     * Send our Lightning address to the peer, request their address, then peer over Lightning
     *
     * @param accountId Account ID of peer to exchange peering info
     * @returns Identity public key from the peer
     */
    async sharePeeringInfo(accountId): Promise<string | undefined> {
      const response = await sendMessage(accountId, peeringResponse).catch(
        err => log(`Error while exchanging peering info: ${err.message}`)
      )

      if (isPeeringRequestMessage(response)) {
        const { lightningAddress: peerAddress } = response

        const [identityPubKey] = response.lightningAddress.split('@')
        accountToPubkey.set(accountId, identityPubKey)

        try {
          await connectPeer(lightningClient, peerAddress)
          log(
            'Successfully peered over Lightning: account=%s address=%s',
            accountId,
            peerAddress
          )
        } catch (err) {
          log(
            'Unable to peer over Lightning: account=%s address=%s',
            accountId,
            peerAddress,
            err
          )
        }

        return identityPubKey
      }
    },

    async settle(accountId, amount) {
      const amountBtc = amount.decimalPlaces(8) // Limit precision to satoshis
      const amountSats = amountBtc.shiftedBy(8).toNumber()

      const destinationPubkey =
        accountToPubkey.get(accountId) ||
        (await this.sharePeeringInfo(accountId)) // If no pubkey is linked, request it
      if (!destinationPubkey) {
        log(
          `Failed to settle: error fetching peer Lightning address. account=%s btc=%s`,
          accountId,
          amountBtc
        )
        return new BigNumber(0)
      }

      try {
        const preimage = await promisify(randomBytes)(32)
        const paymentHash = sha256(preimage)

        /**
         * Sending payments:
         * 1) Quickly send a preimage to the recipient, which they will use to add an invoice on their node
         * 2) Immeditaely try to send a Lightning payment to them using that invoice
         *
         * Thus, there's a race condition: if the pending HTLC reaches their node before the invoice is added,
         * the payment will fail. However, since Lightning is *very* slow, this doesn't occur in a local environment
         * with no latency. To experience this failure, the latency between two peers' connectors would need to be
         * much higher than the latency between all Lightning nodes in the shortest payment path (unlikely).
         *
         * Rationale for this design:
         * - Lightning does not yet support spontaneous payments, but they're coming soon with AMP. That will
         *   simplify this so we don't need to share any invoices.
         * - The previous approach was the recipient would "preshare" ~10 invoices, but this introduced
         *   other problems, since invoices expire and would constantly need to be regenerated. In order to make this
         *   work with SEs, the sender would also need to persist the available invoices for each account.
         */

        sendMessage(accountId, {
          type: 'paymentPreimage',
          preimage: preimage.toString('hex')
        }).catch(err =>
          log(
            'Error sending payment preimage to peer: account=%s btc=%s preimage=%s',
            accountId,
            amountBtc,
            preimage,
            err
          )
        )

        log(
          'Sending Lightning payment: account=%s btc=%s pubkey=%s preimage=%s',
          accountId,
          amountBtc,
          destinationPubkey,
          preimage.toString('hex')
        )
        await payInvoice(paymentStream, {
          destString: destinationPubkey,
          amt: amountSats,
          paymentHash,
          finalCltvDelta: SEND_PAYMENT_FINAL_CLTV_DELTA
        })

        return amountBtc
      } catch (err) {
        log(
          'Failed to send payment: account=%s btc=%s',
          accountId,
          amountBtc,
          err
        )
        return new BigNumber(0)
      }
    },

    async handleMessage(accountId, message) {
      if (isPeeringRequestMessage(message)) {
        const [identityPublicKey] = message.lightningAddress.split('@')
        accountToPubkey.set(accountId, identityPublicKey)
        log(
          'Linked public key to account: account=%s pubkey=%s',
          accountId,
          identityPublicKey
        )

        return peeringResponse
      } else if (isPaymentPreimageMessage(message)) {
        // TODO Rate limit this so we're not DoS-ed with new invoices?

        const { preimage } = message
        paymentToAccount.set(preimage, accountId)

        log(
          'Preparing to receive payment: account=%s preimage=%s',
          accountId,
          preimage
        )
        await lightningClient.addInvoice({
          rPreimage: Buffer.from(preimage, 'hex')
        })
      } else {
        throw new Error('Received unsupported message type')
      }
    },

    async disconnect() {
      if (grpcClient) {
        grpcClient.close()
      }
    }
  }

  return self
}
