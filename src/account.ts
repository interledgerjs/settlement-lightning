import LightningPlugin from '.'

import {
  MIME_APPLICATION_JSON,
  MIME_APPLICATION_OCTET_STREAM,
  TYPE_MESSAGE
} from 'btp-packet'
import {
  deserializeIlpPrepare,
  Errors,
  errorToReject,
  IlpPacket,
  IlpPrepare,
  Type
} from 'ilp-packet'
import { BtpPacket, BtpPacketData, BtpSubProtocol } from 'ilp-plugin-btp'

import BigNumber from 'bignumber.js'
import { decode as decodeInvoice } from 'bolt11'
import { randomBytes } from 'crypto'
import { EventEmitter2 } from 'eventemitter2'
import { promisify } from 'util'

import { Invoice } from '../generated/rpc_pb'

import { DataHandler, MoneyHandler } from './utils/types'

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
  convert(num, from, Unit.Satoshi) + ' Satoshis'

export const getSubProtocol = (message: BtpPacketData, name: string) =>
  message.protocolData.find((p: BtpSubProtocol) => p.protocolName === name)

export const requestId = async () =>
  (await promisify(randomBytes)(4)).readUInt32BE(0)

export default class LightningAccount extends EventEmitter2 {
  public moneyHandler?: MoneyHandler

  // top level plugin
  private master: LightningPlugin

  // counterparty information
  private account: {
    accountName: string
    balance: BigNumber
    lndIdentityPubkey?: string
    payoutAmount: BigNumber
  }

  /**
   * Requests that this instance pays the the peer/counterparty
   * Mapping of paymentRequest -> paymentHash
   * Paid in FIFO order
   */
  private incomingInvoices = new Map<string, string>()

  // Requests that the peer/counterparty pays this instance
  private outgoingInvoices = new Set<string>()

  // used to send BTP packets to counterparty
  private sendMessage: (message: BtpPacket) => Promise<BtpPacketData>

  /**
   * mini-accounts doesn't allow messsages to be sent within `_connect`
   * This is a workaround
   */
  private isConnected = new Promise(r => this.once('connected', r))

  constructor(opts: {
    accountName: string
    master: LightningPlugin
    moneyHandler?: MoneyHandler
    sendMessage: (message: BtpPacket) => Promise<BtpPacketData>
  }) {
    super()

    this.master = opts.master
    this.moneyHandler = opts.moneyHandler
    this.sendMessage = opts.sendMessage
    // Tracks the account we have with our counterparty.
    this.account = {
      accountName: opts.accountName,
      balance: new BigNumber(0),
      payoutAmount: this.master._balance.settleTo.gt(0)
        ? // If we're prefunding, we don't care about total fulfills
          // Since we take the min of this and (balance - settleTo),
          // this essentially disregards the payout amount
          new BigNumber(Infinity)
        : // If we're settling up after fulfills, then we do care
          new BigNumber(0)
    }
  }

  public async connect() {
    // retrieve stored account
    const accountKey = `${this.account.accountName}:account`
    await this.master._store.loadObject(accountKey)
    const savedAccount: any = this.master._store.getObject(accountKey) || {}
    // If account exists, convert balance to BigNumber
    if (typeof savedAccount.balance === 'string') {
      savedAccount.balance = new BigNumber(savedAccount.balance)
    }
    if (typeof savedAccount.payoutAmount === 'string') {
      savedAccount.payoutAmount = new BigNumber(savedAccount.payoutAmount)
    }
    this.account = new Proxy(
      {
        ...this.account,
        ...savedAccount
      },
      {
        set: (account, key, val) => {
          const newAccount = {
            ...account,
            [key]: val
          }
          this.master._store.set(accountKey, JSON.stringify(newAccount))
          return Reflect.set(account, key, val)
        }
      }
    )

    this.master.lightning.invoiceStream.on('data', (data: Invoice) =>
      this.handleIncomingPayment(data)
    )

    // Don't block the rest of connect from returning (for mini-accounts)
    this.isConnected
      .then(async () => {
        await this.sendPeeringInfo()
        await this.sendInvoices(20)
      })
      .catch(err =>
        this.master._log.error(`Error on connect handshake: ${err.message}`)
      )
  }

  public async handleData(
    { data }: BtpPacket,
    dataHandler: DataHandler
  ): Promise<BtpSubProtocol[]> {
    const peeringRequest = getSubProtocol(data, 'peeringRequest')
    if (peeringRequest) {
      try {
        const { lndIdentityPubkey, lndPeeringHost } = JSON.parse(
          peeringRequest.data.toString()
        )

        this.master._log.trace(
          `Attempting to peer over Lightning with ${lndIdentityPubkey}`
        )

        await this.master.lightning.connectPeer(
          lndIdentityPubkey,
          lndPeeringHost
        )

        this.account.lndIdentityPubkey = lndIdentityPubkey
        this.master._log.info(`Successfully peered with ${lndIdentityPubkey}`)
      } catch (err) {
        throw new Error(`Failed to add peer: ${err.message}`)
      }
    }

    const incomingInvoices = getSubProtocol(data, 'invoices')
    if (incomingInvoices) {
      const invoices = JSON.parse(incomingInvoices.data.toString()) as string[]

      // If any of the invoices are invalid, return a BTP error
      for (const invoice of invoices) {
        // Throws if the invoice wasn't signed correctly
        const { satoshis, payeeNodeKey, tags } = decodeInvoice(invoice)

        // Payee = entity to whom money is paid (the peer)
        const toPeer = payeeNodeKey === this.account.lndIdentityPubkey
        if (!toPeer) {
          throw new Error(
            `Invalid incoming invoice: ${payeeNodeKey} does not match the peer's LND public key: ${
              this.master._lndIdentityPubkey
            }`
          )
        }

        const anyAmount = satoshis === null
        if (!anyAmount) {
          throw new Error(
            `Invalid incoming invoice: amount of ${satoshis} does not allow paying an arbitrary amount`
          )
        }

        const paymentHash = tags.find(
          ({ tagName }) => tagName === 'payment_hash'
        )
        if (!paymentHash) {
          throw new Error(`Invalid incoming invoice: no payment hash provided`)
        }

        this.incomingInvoices.set(invoice, paymentHash.data)
      }

      // Since there are new invoices, attempt settlement
      this.attemptSettle().catch(err =>
        this.master._log.error(`Error during settlement: ${err.message}`)
      )
    }

    // Handle incoming ILP PREPARE packets from peer
    // plugin-btp handles correlating the response packets for the dataHandler
    const ilp = getSubProtocol(data, 'ilp')
    if (ilp && ilp.data[0] === Type.TYPE_ILP_PREPARE) {
      return this.handlePrepare(ilp, dataHandler)
    }

    return []
  }

  // Handle the response from a forwarded ILP PREPARE
  public handlePrepareResponse(
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
        this.account.payoutAmount = this.account.payoutAmount.plus(amount)
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

  public async disconnect() {
    return this.master._store.unload(`${this.account.accountName}:account`)
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
            contentType: MIME_APPLICATION_JSON,
            data: Buffer.from(
              JSON.stringify({
                lndIdentityPubkey: this.master._lndIdentityPubkey,
                lndPeeringHost:
                  this.master._lndHost + ':' + this.master._peerPort
              })
            )
          }
        ]
      }
    }).catch(err =>
      this.master._log.error(
        `Error while exchanging peering info: ${err.message}`
      )
    )
  }

  private async sendInvoices(numInvoices: number): Promise<void> {
    /**
     * Since each invoice is only associated with this account, and
     * we assume Lightning will never generate a duplicate invoice,
     * no single invoice should be credited to more than one account.
     */

    const invoices = await Promise.all(
      Array(numInvoices)
        .fill(null)
        .map(() => this.master.lightning.createPaymentRequest())
    )
    this.outgoingInvoices = new Set([...this.outgoingInvoices, ...invoices])

    await this.sendMessage({
      type: TYPE_MESSAGE,
      requestId: await requestId(),
      data: {
        protocolData: [
          {
            protocolName: 'invoices',
            contentType: MIME_APPLICATION_JSON,
            data: Buffer.from(JSON.stringify(invoices))
          }
        ]
      }
    }).catch(err =>
      this.master._log.error(`Error while exchanging invoices: ${err.message}`)
    )
  }

  /**
   * Send settlements and credit incoming settlements
   */

  private handleIncomingPayment(invoice: Invoice) {
    const isPaid = invoice.getSettled()
    const isLinkedToAccount = this.outgoingInvoices.has(
      invoice.getPaymentRequest()
    )
    if (isPaid && isLinkedToAccount) {
      this.outgoingInvoices.delete(invoice.getPaymentRequest())
      this.subBalance(new BigNumber(invoice.getAmtPaidSat()))

      if (typeof this.moneyHandler !== 'function') {
        throw new Error('no money handler registered')
      }
      this.moneyHandler(invoice.getAmtPaidSat().toString()).catch(err =>
        this.master._log.error(`Error in money handler: ${err.message}`)
      )

      // Send another invoice to the peer so they're still able to pay us
      this.sendInvoices(1).catch(err =>
        this.master._log.error(
          `Failed to send invoice (peer may become unable to pay us): ${
            err.message
          }`
        )
      )
    }
  }

  private async attemptSettle(): Promise<void> {
    // By default, the settleThreshold is -Infinity,
    // so it will never settle (receive-only mode)
    const shouldSettle =
      this.master._balance.settleThreshold.gt(this.account.balance) &&
      this.account.payoutAmount.gt(0)

    if (!shouldSettle) {
      return
    }

    // Determine the amount to settle for
    const settlementBudget = BigNumber.min(
      this.master._balance.settleTo.minus(this.account.balance),
      // - If we're not prefunding, the amount should be limited
      //   by the total packets we've fulfilled
      // - If we're prefunding, the payoutAmount is infinity, so
      //   it doesn't affect the amount to settle
      this.account.payoutAmount
    )

    // This should never error, since settleTo < maximum
    this.addBalance(settlementBudget)
    this.account.payoutAmount = this.account.payoutAmount.minus(
      settlementBudget
    )

    this.master._log.debug(
      `Settlement triggered with ` +
        `${this.account.accountName} for ` +
        `${format(settlementBudget, Unit.Satoshi)}`
    )

    // After this point, any uncaught or thrown error should revert balance
    try {
      // Grab an invoice from that set available
      const invoice = this.incomingInvoices.entries().next().value
      if (!invoice) {
        throw new Error('no cached invoices to pay')
      }

      // Delete the invoice before it's paid so we don't accidentally pay it twice
      const [paymentRequest, paymentHash] = invoice
      this.incomingInvoices.delete(paymentRequest)

      await this.master.lightning.payInvoice(
        paymentRequest,
        paymentHash,
        settlementBudget
      )

      this.master._log.info(
        `Successfully settled with ${
          this.account.lndIdentityPubkey
        } for ${format(settlementBudget, Unit.Satoshi)}`
      )
    } catch (err) {
      this.subBalance(settlementBudget)
      this.account.payoutAmount = this.account.payoutAmount.plus(
        settlementBudget
      )

      this.master._log.error(`Failed to settle: ${err.message}`)
    }
  }

  /**
   * Generic plugin boilerplate (not specific to Lightning)
   */

  private async handlePrepare(
    { data }: BtpSubProtocol,
    dataHandler: DataHandler
  ) {
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

      const response = await dataHandler(data)

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

  private addBalance(amount: BigNumber) {
    if (amount.isZero()) {
      return
    }

    const maximum = this.master._balance.maximum
    const newBalance = this.account.balance.plus(amount)

    if (newBalance.gt(maximum)) {
      throw new Error(
        `Cannot debit ${format(amount, Unit.Satoshi)} from ${
          this.account.accountName
        }, ` +
          `proposed balance of ${format(
            newBalance,
            Unit.Satoshi
          )} exceeds maximum of ${format(maximum, Unit.Satoshi)}`
      )
    }

    this.master._log.debug(
      `Debited ${format(amount, Unit.Satoshi)} from ${
        this.account.accountName
      }, new balance is ${format(newBalance, Unit.Satoshi)}`
    )
    this.account.balance = newBalance
  }

  private subBalance(amount: BigNumber) {
    if (amount.isZero()) {
      return
    }

    const minimum = this.master._balance.minimum
    const newBalance = this.account.balance.minus(amount)

    if (newBalance.lt(minimum)) {
      throw new Error(
        `Cannot credit ${format(amount, Unit.Satoshi)} to account ${
          this.account.accountName
        }, ` +
          `proposed balance of ${format(
            newBalance,
            Unit.Satoshi
          )} is below minimum of ${format(minimum, Unit.Satoshi)}`
      )
    }

    this.master._log.debug(
      `Credited ${format(amount, Unit.Satoshi)} to ${
        this.account.accountName
      }, new balance is ${format(newBalance, Unit.Satoshi)}`
    )
    this.account.balance = newBalance
  }
}
