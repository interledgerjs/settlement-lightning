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
  IlpPacket,
  IlpPrepare,
  Type
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

export const requestId = async () =>
  (await promisify(randomBytes)(4)).readUInt32BE(0)

export default class LightningAccount extends EventEmitter2 {
  /** Hash/account identifier in ILP address */
  readonly accountName: string
  /**
   * Net amount in satoshi the counterparty owes the this instance
   * - Negative implies this instance owes the counterparty
   */
  readonly balance$: BehaviorSubject<BigNumber>
  /**
   * Sum of all fulfilled packets owed to the counterparty that have yet to be paid out (always >= 0
   * - The balance limits when settlements happen, but this limits the settlement amount so we don't send
   *   all the clients' money directly back to them!
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
    balance$,
    payoutAmount$,
    master,
    sendMessage,
    dataHandler,
    moneyHandler
  }: {
    accountName: string
    balance$: BehaviorSubject<BigNumber>
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

    this.balance$ = balance$
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
      this.attemptSettle().catch(err =>
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
      requestId: await requestId(),
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
      requestId: await requestId(),
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
        `received incoming payment for ${format(
          invoice.getAmtPaidSat(),
          Unit.Satoshi
        )}`
      )

      this.subBalance(new BigNumber(invoice.getAmtPaidSat()))
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

  private async sendMoney(amount: BigNumber): Promise<void> {
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

    const { paymentRequest, paymentHash } = invoice
    await payInvoice(
      this.master._paymentStream!,
      paymentRequest,
      paymentHash,
      amount
    )
  }

  /**
   * Generic plugin boilerplate (not specific to Lightning)
   */

  private async attemptSettle(): Promise<void> {
    /**
     * By default, the settleThreshold is -Infinity,
     * so it will never settle (receive-only mode)
     */
    const shouldSettle = this.master._balance.settleThreshold.gt(
      this.balance$.getValue()
    )
    if (!shouldSettle) {
      return
    }

    /**
     * Determine the amount to settle for, always limited
     * by the total amount of packets we've fulfilled
     */
    const settlementBudget = this.master._balance.settleTo.plus(
      this.payoutAmount$.getValue()
    )
    if (settlementBudget.lte(0)) {
      return
    }

    // TODO Would this ever go above the maximum balance (after change)?
    // This should never error, since settleTo < maximum
    this.addBalance(settlementBudget)
    this.payoutAmount$.next(
      this.payoutAmount$.getValue().minus(settlementBudget)
    )

    this.master._log.debug(
      `Settlement triggered with ${this.accountName} for ${format(
        settlementBudget,
        Unit.Satoshi
      )}`
    )

    // After this point, any uncaught or thrown error should revert balance
    try {
      await this.sendMoney(settlementBudget)

      this.master._log.info(
        `Successfully settled with ${this.peerIdentityPublicKey} for ${format(
          settlementBudget,
          Unit.Satoshi
        )}`
      )
    } catch (err) {
      this.subBalance(settlementBudget)
      this.payoutAmount$.next(
        this.payoutAmount$.getValue().plus(settlementBudget)
      )

      this.master._log.error(`Failed to settle: ${err.message}`)
    }
  }

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

      try {
        this.addBalance(amountBN)
      } catch (err) {
        this.master._log.trace(`Failed to forward PREPARE: ${err.message}`)
        throw new Errors.InsufficientLiquidityError(err.message)
      }

      const response = await this.dataHandler(data)

      if (response[0] === Type.TYPE_ILP_REJECT) {
        this.subBalance(amountBN)
      } else if (response[0] === Type.TYPE_ILP_FULFILL) {
        this.master._log.trace(
          `Received FULFILL from data handler in response to forwarded PREPARE`
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
  handlePrepareResponse(
    preparePacket: {
      type: Type.TYPE_ILP_PREPARE
      typeString?: 'ilp_prepare'
      data: IlpPrepare
    },
    responsePacket: IlpPacket
  ): void {
    const isFulfill = responsePacket.type === Type.TYPE_ILP_FULFILL
    if (isFulfill) {
      this.master._log.trace(
        `Received a FULFILL in response to the forwarded PREPARE from sendData`
      )

      // Update balance to reflect that we owe them the amount of the FULFILL
      const amount = new BigNumber(preparePacket.data.amount)
      try {
        this.subBalance(amount)
        this.payoutAmount$.next(this.payoutAmount$.getValue().plus(amount))
      } catch (err) {
        // Balance update likely dropped below the minimum, so throw an internal error
        this.master._log.error(
          `Failed to fulfill response to PREPARE: ${err.message}`
        )
        throw new Errors.InternalError(err.message)
      }
    }

    // Attempt to settle on fulfills and* T04s (to resolve stalemates)
    const shouldSettle =
      isFulfill ||
      (responsePacket.type === Type.TYPE_ILP_REJECT &&
        responsePacket.data.code === 'T04')
    if (shouldSettle) {
      this.attemptSettle().catch(err =>
        this.master._log.error(`Error during settlement: ${err.message}`)
      )
    }
  }

  private addBalance(amount: BigNumber) {
    if (amount.isZero()) {
      return
    }

    const maximum = this.master._balance.maximum
    const newBalance = this.balance$.getValue().plus(amount)

    if (newBalance.gt(maximum)) {
      throw new Error(
        `Cannot debit ${format(amount, Unit.Satoshi)} from ${
          this.accountName
        }, ` +
          `proposed balance of ${format(
            newBalance,
            Unit.Satoshi
          )} exceeds maximum of ${format(maximum, Unit.Satoshi)}`
      )
    }

    this.master._log.debug(
      `Debited ${format(amount, Unit.Satoshi)} from ${
        this.accountName
      }, new balance is ${format(newBalance, Unit.Satoshi)}`
    )
    this.balance$.next(newBalance)
  }

  private subBalance(amount: BigNumber) {
    if (amount.isZero()) {
      return
    }

    const minimum = this.master._balance.minimum
    const newBalance = this.balance$.getValue().minus(amount)

    if (newBalance.lt(minimum)) {
      throw new Error(
        `Cannot credit ${format(amount, Unit.Satoshi)} to account ${
          this.accountName
        }, ` +
          `proposed balance of ${format(
            newBalance,
            Unit.Satoshi
          )} is below minimum of ${format(minimum, Unit.Satoshi)}`
      )
    }

    this.master._log.debug(
      `Credited ${format(amount, Unit.Satoshi)} to ${
        this.accountName
      }, new balance is ${format(newBalance, Unit.Satoshi)}`
    )
    this.balance$.next(newBalance)
  }

  unload() {
    this.master._accounts.delete(this.accountName)
  }
}
