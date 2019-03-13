import BigNumber from 'bignumber.js'
import { decode as decodeInvoice } from 'bolt11'
import {
  MIME_APPLICATION_OCTET_STREAM,
  MIME_TEXT_PLAIN_UTF8,
  TYPE_MESSAGE
} from 'btp-packet'
import { randomBytes } from 'crypto'
import { EventEmitter2 } from 'eventemitter2'
import {
  deserializeIlpPrepare,
  Errors,
  errorToReject,
  IlpPrepare,
  isReject,
  isFulfill,
  IlpReply,
  deserializeIlpReply
} from 'ilp-packet'
import { BtpPacket, BtpPacketData, BtpSubProtocol } from 'ilp-plugin-btp'
import pTimes from 'p-times'
import { promisify } from 'util'
import LightningPlugin from '.'
import { Invoice } from '../generated/rpc_pb'
import { DataHandler, MoneyHandler } from './types/plugin'
import { connectPeer, createPaymentRequest, payInvoice } from './lightning'
import { BehaviorSubject } from 'rxjs'

// Used to denominate which asset scale we are using
export enum Unit {
  BTC = 8,
  Satoshi = 0
}

// Simple conversion for BTC <-> Satoshi
export const convert = (
  num: BigNumber.Value,
  from: Unit,
  to: Unit
): BigNumber => new BigNumber(num).shiftedBy(from - to)

export const format = (num: BigNumber.Value, from: Unit) =>
  convert(num, from, Unit.Satoshi) + ' satoshis'

export type ParsedSubprotocol = string | Buffer | undefined

export const getSubProtocol = (
  message: BtpPacketData,
  name: string
): ParsedSubprotocol => {
  const subProtocol = message.protocolData.find(
    (p: BtpSubProtocol) => p.protocolName === name
  )
  if (subProtocol) {
    const { contentType, data } = subProtocol
    return contentType === MIME_APPLICATION_OCTET_STREAM
      ? data
      : data.toString()
  }
}

export const generateBtpRequestId = async () =>
  (await promisify(randomBytes)(4)).readUInt32BE(0)

export default class LightningAccount extends EventEmitter2 {
  /** Hash/account identifier in ILP address */
  readonly accountName: string

  /** Incoming amount owed to us by our peer for their packets we've forwarded */
  readonly receivableBalance$: BehaviorSubject<BigNumber>

  /** Outgoing amount owed by us to our peer for packets we've sent to them */
  readonly payableBalance$: BehaviorSubject<BigNumber>

  /**
   * Amount of failed outgoing settlements that is owed to the peer, but not reflected
   * in the payableBalance (e.g. due to sendMoney calls on client)
   */
  readonly payoutAmount$: BehaviorSubject<BigNumber>

  /** Lightning public key linked for the session */
  peerIdentityPublicKey?: string

  /** Expose access to common configuration across accounts */
  private readonly master: LightningPlugin

  /** Send the given BTP packet message to this counterparty */
  private readonly sendMessage: (message: BtpPacket) => Promise<BtpPacketData>

  /** Data handler from plugin for incoming ILP packets */
  private readonly dataHandler: DataHandler

  /** Money handler from plugin for incoming money */
  private readonly moneyHandler: MoneyHandler

  /**
   * Requests that this instance pays the the peer/counterparty, to be paid in FIFO order
   * - Cached for duration of session
   */
  private incomingInvoices: {
    paymentRequest: string
    paymentHash: string
    expiry: number // UNIX timestamp denoting when the invoice expires in LND (seconds)
  }[] = []

  /**
   * Requests that the peer/counterparty pays this instance
   * - Mapping of paymentRequest to a timer to send a new invoice before this one expires
   * - Cached for duration of session
   */

  private outgoingInvoices = new Map<string, NodeJS.Timeout>()

  /**
   * Promise that resolves when plugin is ready to send messages
   * (workaroud since mini-accounts doesn't allow messsages to be sent within `_connect`)
   */
  private isConnected = new Promise(r => this.once('connected', r))

  constructor({
    accountName,
    payableBalance$,
    receivableBalance$,
    payoutAmount$,
    master,
    sendMessage,
    dataHandler,
    moneyHandler
  }: {
    accountName: string
    payableBalance$: BehaviorSubject<BigNumber>
    receivableBalance$: BehaviorSubject<BigNumber>
    payoutAmount$: BehaviorSubject<BigNumber>
    master: LightningPlugin
    // Wrap _call/expose method to send WS messages
    sendMessage: (message: BtpPacket) => Promise<BtpPacketData>
    dataHandler: DataHandler
    moneyHandler: MoneyHandler
  }) {
    super()

    this.master = master
    this.sendMessage = sendMessage
    this.dataHandler = dataHandler
    this.moneyHandler = moneyHandler

    this.accountName = accountName

    this.payableBalance$ = payableBalance$
    this.receivableBalance$ = receivableBalance$
    this.payoutAmount$ = payoutAmount$
  }

  async connect() {
    this.master._invoiceStream!.on('data', (data: Invoice) =>
      this.handleIncomingPayment(data)
    )

    // Don't block the rest of connect from returning (for mini-accounts)
    this.isConnected
      .then(async () => {
        await this.sendPeeringInfo()
        await pTimes(20, () => this.sendInvoice())
      })
      .catch(err =>
        this.master._log.error(`Error on connect handshake: ${err.message}`)
      )
  }

  async handleData({ data }: BtpPacket): Promise<BtpSubProtocol[]> {
    const peeringRequest = getSubProtocol(data, 'peeringRequest')
    if (typeof peeringRequest === 'string') {
      try {
        const [identityPublicKey, host] = peeringRequest.split('@')

        // Lightning public key and invoices are linked for the duration of the session
        const linkedPubkey = this.peerIdentityPublicKey
        if (linkedPubkey && linkedPubkey !== identityPublicKey) {
          throw new Error(
            `${linkedPubkey} is already linked to account ${
              this.accountName
            } for the remainder of the session`
          )
        }

        this.master._log.debug(
          `Attempting to peer over Lightning with ${identityPublicKey}`
        )

        await connectPeer(this.master._lightning)(identityPublicKey, host)

        this.peerIdentityPublicKey = identityPublicKey
        this.master._log.info(`Successfully peered with ${identityPublicKey}`)
      } catch (err) {
        throw new Error(`Failed to add peer: ${err.message}`)
      }
    }

    const paymentRequest = getSubProtocol(data, 'paymentRequest')
    if (typeof paymentRequest === 'string') {
      // Throws if the invoice wasn't signed correctly
      const { satoshis, payeeNodeKey, timestamp, tags } = decodeInvoice(
        paymentRequest
      )

      if (!this.peerIdentityPublicKey) {
        throw new Error(
          `Cannot accept incoming invoice: no public key linked to account`
        )
      }

      // Payee = entity to whom money is paid (the peer)
      const toPeer = payeeNodeKey === this.peerIdentityPublicKey
      if (!toPeer) {
        throw new Error(
          `Invalid incoming invoice: ${payeeNodeKey} does not match the peer's public key: ${
            this.peerIdentityPublicKey
          }`
        )
      }

      const anyAmount = satoshis === null
      if (!anyAmount) {
        throw new Error(
          `Invalid incoming invoice: amount of ${satoshis} does not allow paying an arbitrary amount`
        )
      }

      const paymentHash = tags.find(({ tagName }) => tagName === 'payment_hash')
      if (!paymentHash) {
        throw new Error(`Invalid incoming invoice: no payment hash provided`)
      }

      const expireTag = tags.find(({ tagName }) => tagName === 'expire_time')
      // Default expiry per BOLT11 spec is 1 hour / 3600 seconds
      const expiry = (expireTag ? expireTag.data : 3600) + timestamp

      this.incomingInvoices.push({
        paymentRequest,
        paymentHash: paymentHash.data,
        expiry
      })

      // Since there is a new invoice, attempt settlement
      this.sendMoney().catch(err =>
        this.master._log.error(`Error during settlement: ${err.message}`)
      )
    }

    // Handle incoming ILP PREPARE packets from peer
    // plugin-btp handles correlating the response packets for the dataHandler
    const ilp = getSubProtocol(data, 'ilp')
    if (Buffer.isBuffer(ilp)) {
      return this.handlePrepare(ilp)
    }

    return []
  }

  /**
   * Handle Lightning-specific messages between peers
   */

  private async sendPeeringInfo(): Promise<void> {
    this.master._log.debug(`Sharing identity pubkey with peer`)

    await this.sendMessage({
      type: TYPE_MESSAGE,
      requestId: await generateBtpRequestId(),
      data: {
        protocolData: [
          {
            protocolName: 'peeringRequest',
            contentType: MIME_TEXT_PLAIN_UTF8,
            data: Buffer.from(this.master._lightningAddress!, 'utf8')
          }
        ]
      }
    }).catch(err =>
      this.master._log.error(
        `Error while exchanging peering info: ${err.message}`
      )
    )
  }

  private async sendInvoice(): Promise<void> {
    this.master._log.info(`Sending payment request to peer`)

    /**
     * Since each invoice is only associated with this account, and
     * we assume Lightning will never generate a duplicate invoice,
     * no single invoice should be credited to more than one account.
     *
     * Per https://api.lightning.community/#addinvoice
     * "Any duplicated invoices are rejected, therefore all invoices must have a unique payment preimage."
     */

    const paymentRequest = await createPaymentRequest(this.master._lightning)

    /**
     * In 55 minutes, send a new invoice to replace this one
     * LND default expiry is 1 hour (3600 seconds), since we didn't specify one
     */
    const expiry = 3300
    this.outgoingInvoices.set(
      paymentRequest,
      setTimeout(() => {
        this.outgoingInvoices.delete(paymentRequest)
        this.sendInvoice().catch(err =>
          this.master._log.error(
            `Failed to replace soon-expiring invoice (peer may become unable to pay us): ${
              err.message
            }`
          )
        )
      }, expiry * 1000)
    )

    await this.sendMessage({
      type: TYPE_MESSAGE,
      requestId: await generateBtpRequestId(),
      data: {
        protocolData: [
          {
            protocolName: 'paymentRequest',
            contentType: MIME_TEXT_PLAIN_UTF8,
            data: Buffer.from(paymentRequest, 'utf8')
          }
        ]
      }
    }).catch(err =>
      this.master._log.error(`Error while exchanging invoice: ${err.message}`)
    )
  }

  /**
   * Send settlements and credit incoming settlements
   */

  private handleIncomingPayment(invoice: Invoice) {
    const paymentRequest = invoice.getPaymentRequest()

    const isPaid = invoice.getSettled()
    const isLinkedToAccount = this.outgoingInvoices.has(paymentRequest)

    if (isPaid && isLinkedToAccount) {
      clearTimeout(this.outgoingInvoices.get(paymentRequest)!) // Remove expiry timer to replace this invoice
      this.outgoingInvoices.delete(paymentRequest)

      this.master._log.info(
        `Received incoming payment for ${format(
          invoice.getAmtPaidSat(),
          Unit.Satoshi
        )}`
      )

      this.receivableBalance$.next(
        this.receivableBalance$.value.minus(invoice.getAmtPaidSat())
      )

      this.moneyHandler(invoice.getAmtPaidSat().toString()).catch(err =>
        this.master._log.error(`Error in money handler: ${err.message}`)
      )

      // Send another invoice to the peer so they're still able to pay us
      this.sendInvoice().catch(err =>
        this.master._log.error(
          `Failed to send invoice (peer may become unable to pay us): ${
            err.message
          }`
        )
      )
    }
  }

  async sendMoney(amount?: string): Promise<void> {
    const amountToSend = amount || BigNumber.max(0, this.payableBalance$.value)
    this.payoutAmount$.next(this.payoutAmount$.value.plus(amountToSend))

    const settlementBudget = this.payoutAmount$.value
    if (settlementBudget.isLessThanOrEqualTo(0)) {
      return
    }

    this.payableBalance$.next(
      this.payableBalance$.value.minus(settlementBudget)
    )

    // payoutAmount$ is positive and CANNOT go below 0
    this.payoutAmount$.next(
      BigNumber.min(0, this.payoutAmount$.value.minus(settlementBudget))
    )

    try {
      // Prune invoices that expire within the next minute
      const minuteFromNow = Date.now() / 1000 + 60 // Unix timestamp for 1 minute from now
      this.incomingInvoices = this.incomingInvoices.filter(
        ({ expiry }) => minuteFromNow < expiry
      )

      // Get the oldest invoice as the one to pay
      // Remove it immediately so we don't pay it twice
      const invoice = this.incomingInvoices.shift()
      if (!invoice) {
        throw new Error('no valid cached invoices to pay')
      }

      this.master._log.debug(
        `Settlement triggered with ${this.accountName} for ${format(
          settlementBudget,
          Unit.Satoshi
        )}`
      )

      const { paymentRequest, paymentHash } = invoice
      await payInvoice(
        this.master._paymentStream!,
        paymentRequest,
        paymentHash,
        settlementBudget
      )

      this.master._log.info(
        `Successfully settled with ${this.peerIdentityPublicKey} for ${format(
          amountToSend,
          Unit.Satoshi
        )}`
      )
    } catch (err) {
      this.payableBalance$.next(
        this.payableBalance$.value.plus(settlementBudget)
      )

      // payoutAmount$ is positive and CANNOT go below 0
      this.payoutAmount$.next(
        BigNumber.max(0, this.payoutAmount$.value.plus(settlementBudget))
      )

      this.master._log.error('Failed to settle:', err)
    }
  }

  unload() {
    // Don't refresh existing invoices
    this.outgoingInvoices.forEach(timer => clearTimeout(timer))
    this.master._accounts.delete(this.accountName)
  }

  /**
   * Generic plugin boilerplate (not specific to Lightning)
   */

  private async handlePrepare(data: Buffer) {
    try {
      const { amount } = deserializeIlpPrepare(data)
      const amountBN = new BigNumber(amount)

      if (amountBN.gt(this.master._maxPacketAmount)) {
        throw new Errors.AmountTooLargeError('Packet size is too large.', {
          receivedAmount: amount,
          maximumAmount: this.master._maxPacketAmount.toString()
        })
      }

      const newBalance = this.receivableBalance$.value.plus(amount)
      if (newBalance.isGreaterThan(this.master._maxBalance)) {
        this.master._log.debug(
          `Cannot forward PREPARE: cannot debit ${format(
            amount,
            Unit.Satoshi
          )}: proposed balance of ${format(
            newBalance,
            Unit.Satoshi
          )} exceeds maximum of ${format(
            this.master._maxBalance,
            Unit.Satoshi
          )}`
        )
        throw new Errors.InsufficientLiquidityError('Exceeded maximum balance')
      }

      this.master._log.debug(
        `Forwarding PREPARE: Debited ${format(
          amount,
          Unit.Satoshi
        )}, new balance is ${format(newBalance, Unit.Satoshi)}`
      )
      this.receivableBalance$.next(newBalance)

      const response = await this.dataHandler(data)
      const reply = deserializeIlpReply(response)

      if (isReject(reply)) {
        this.master._log.debug(
          `Credited ${format(amount, Unit.Satoshi)} in response to REJECT`
        )
        this.receivableBalance$.next(
          this.receivableBalance$.value.minus(amount)
        )
      } else if (isFulfill(reply)) {
        this.master._log.debug(
          `Received FULFILL in response to forwarded PREPARE`
        )
      }

      return [
        {
          protocolName: 'ilp',
          contentType: MIME_APPLICATION_OCTET_STREAM,
          data: response
        }
      ]
    } catch (err) {
      return [
        {
          protocolName: 'ilp',
          contentType: MIME_APPLICATION_OCTET_STREAM,
          data: errorToReject('', err)
        }
      ]
    }
  }

  // Handle the response from a forwarded ILP PREPARE
  handlePrepareResponse(prepare: IlpPrepare, reply: IlpReply) {
    if (isFulfill(reply)) {
      // Update balance to reflect that we owe them the amount of the FULFILL
      const amount = new BigNumber(prepare.amount)

      this.master._log.debug(
        `Received a FULFILL in response to forwarded PREPARE: credited ${format(
          amount,
          Unit.Satoshi
        )}`
      )
      this.payableBalance$.next(this.payableBalance$.value.plus(amount))
    } else if (isReject(reply)) {
      this.master._log.debug(
        `Received a ${reply.code} REJECT in response to the forwarded PREPARE`
      )
    }

    // Attempt to settle on fulfills *and* T04s (to resolve stalemates)
    const shouldSettle =
      isFulfill(reply) || (isReject(reply) && reply.code === 'T04')
    if (shouldSettle) {
      this.sendMoney().catch((err: Error) =>
        this.master._log.debug(`Error during settlement: ${err.message}`)
      )
    }
  }
}
