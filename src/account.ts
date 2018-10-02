import LightningPlugin = require('.')

const btpPacket = require('btp-packet')
import * as IlpPacket from 'ilp-packet'
import {
  BtpPacket,
  BtpPacketData,
  BtpSubProtocol
} from 'ilp-plugin-btp'

import {
  ilpAndCustomToProtocolData
} from 'ilp-plugin-btp/src/protocol-data-converter'

import BigNumber from 'bignumber.js'
import { randomBytes } from 'crypto'
import { promisify } from 'util'

import {
  DataHandler,
  MoneyHandler
} from './utils/types'

// Used to denominate which asset scale we are using
export enum Unit {
  BTC = 8, Satoshi = 0
}

// Simple conversion for BTC <-> Satoshi
export const convert = (num: BigNumber.Value, from: Unit, to: Unit):
  BigNumber => new BigNumber(num).shiftedBy(from - to)

export const format = (num: BigNumber.Value, from: Unit) =>
  convert(num, from, Unit.Satoshi) + ' Satoshis'

export const getSubProtocol = (message: BtpPacket, name: string) =>
  message.data.protocolData.find((p: BtpSubProtocol) =>
    p.protocolName === name)

export const requestId = async () =>
  (await promisify(randomBytes)(4)).readUInt32BE(0)

export default class LightningAccount {

  // top level plugin
  public master: LightningPlugin

  // counterparty information
  private account: {
    accountName: string
    balance: BigNumber
    lndIdentityPubkey?: string
    payoutAmount: BigNumber
  }
  // used to send BTP packets to counterparty
  private sendMessage: (message: BtpPacket) => Promise<BtpPacketData>

  constructor(opts: {
    accountName: string,
    master: LightningPlugin,
    sendMessage: (message: BtpPacket) => Promise<BtpPacketData>
  }) {
    this.master = opts.master
    this.sendMessage = opts.sendMessage
    // Tracks the account we have with our counterparty.
    this.account = {
      accountName: opts.accountName,
      balance: new BigNumber(0),
      payoutAmount: this.master._balance.settleTo.gt(0)
        // If we're prefunding, we don't care about total fulfills
        // Since we take the min of this and the settleTo/settleThreshold delta,
        //  this essentially disregards the payout amount
        ? new BigNumber(Infinity)
        // If we're settling up after fulfills, then we do care
        : new BigNumber(0)
    }
  }

  public async connect() {
    // retrieve stored account
    const accountKey = `${this.account.accountName}:account`
    await this.master._store.loadObject(accountKey)
    const savedAccount = this.master._store.getObject(accountKey) || {}
    // If account exists, convert balance to BigNumber
    if (typeof savedAccount.balance === 'string') {
      savedAccount.balance = new BigNumber(savedAccount.balance)
    }
    if (typeof savedAccount.payoutAmount === 'string') {
      savedAccount.payoutAmount = new BigNumber(savedAccount.payoutAmount)
    }
    // load account class variable
    this.account = new Proxy({
      ...this.account,
      ...savedAccount
    }, {
        set: (account, key, val) => {
          this.master._store.set(accountKey, JSON.stringify({
            ...account,
            [key]: val
          }))
          return Reflect.set(account, key, val)
        }
      })
    // Clients initiate the exchange of lnd identity pubkeys
    if (this.master._role === 'client') {
      this.master._log.trace(`Sharing identity pubkey with server.`)
      await this.sendPeeringInfo()
    }
  }

  public async sendPeeringInfo(): Promise<void> {
    const response = await this.sendMessage({
      type: btpPacket.TYPE_MESSAGE,
      requestId: await requestId(),
      data: {
        protocolData: [{
          protocolName: 'peeringRequest',
          contentType: btpPacket.MIME_APPLICATION_JSON,
          data: Buffer.from(JSON.stringify({
            lndIdentityPubkey: this.master._lndIdentityPubkey,
            lndPeeringHost: this.master._lndHost + ':' + this.master._peerPort
          }))
        }]
      }
    })

    const subProtocol = response.protocolData.find((p: BtpSubProtocol) =>
      p.protocolName === 'peeringResponse')
    if (subProtocol) {
      const { lndIdentityPubkey } = JSON.parse(subProtocol.data.toString())
      if (!this.master.lnd.isPeer(lndIdentityPubkey)) {
        throw new Error(`Received peeringResponse without peer ` +
          `relationship over lightning`)
      }
      this.account.lndIdentityPubkey = lndIdentityPubkey
      this.master._log.trace(`Succesfully peered with server over lightning.`)
    } else {
      throw new Error(`Received improper response to peeringRequest`)
    }
  }

  public async attemptSettle(): Promise<void> {
    // Biggest difference from ETH is that settlements are all or nothing.
    // We don't try and create a new channel or make smaller settlements,
    // just refund the full amount when a failure occurs.
    let settlementBudget = new BigNumber(0)
    const settleThreshold = this.master._balance.settleThreshold
    // Check if receive only mode is on
    if (!settleThreshold) {
      return this.master._log.trace('Cannot settle. Threshold is undefined')
    }
    // determine if we need to settle
    const shouldSettle = settleThreshold.gt(this.account.balance)
    if (!shouldSettle) {
      return this.master._log.trace(`Should not settle.  Balance of ` +
        `${format(this.account.balance, Unit.Satoshi)} is not below ` +
        `settleThreshold of ${format(settleThreshold, Unit.Satoshi)}`)
    }
    settlementBudget =
      this.master._balance.settleTo.minus(this.account.balance)
    if (settlementBudget.lte(0)) {
      return this.master._log.error(`Critical settlement error: ` +
      `settlement threshold triggered, but settle amount of ` +
      `${format(settlementBudget, Unit.Satoshi)} is 0 or negative`)
    }

    // If we're not prefunding, the amount should be limited by
    // the total packets we've fulfilled
    // If we're prefunding, the payoutAmount is infinity,
    // so it doesn't affect the amount to settle
    settlementBudget =
      BigNumber.min(settlementBudget, this.account.payoutAmount)

    if (settlementBudget.lte(0)) {
      return this.master._log.trace(`Cannot settle: no fulfilled ` +
      `packets have yet to be settled, ` +
      `payout amount is ${format(this.account.payoutAmount, Unit.Satoshi)}`)
    }

    this.master._log.trace(`Attempting to settle with account ` +
      `${this.account.lndIdentityPubkey} for ` +
      `${format(settlementBudget, Unit.Satoshi)}`)

      // begin settlement
    // Optimistically add the balance.
    this.addBalance(settlementBudget)
    // After this point, any uncaught or thrown error should revert balance.
    try {
      const paymentRequest = await this.requestInvoice()

      // TODO Query routes (not working with grpc) instead of
      // checking for channel capacity.

      // Check that we have outgoing capacity in one of our channels
      // sufficient to make the settlement.
      // This assumes we can find a route that uses that channel.

      if (!this.master.lnd.hasAmount(settlementBudget)) {
        this.subBalance(settlementBudget)
        return this.master._log.error(`Cannot settle.  Insufficient ` +
          `funds in channel to complete settlement of ` +
          `${format(settlementBudget, Unit.Satoshi)} ` +
          `Refunding balance for amount: ${settlementBudget}`)
      }
      try {
        await this.master.lnd.payInvoice(paymentRequest, settlementBudget)
      } catch (err) {
        throw new Error(`Error while attempting to pay ` +
          `lightning invoice for payment request: ${paymentRequest}:\n ` +
          `${err}\n` +
          `Refunding balance for amount: ${settlementBudget}`)
      }
      // Send notification of payment
      // TODO Subscribe to notifications on the receiver side
      // so we don't need to do this.
      this.sendMessage({
        type: btpPacket.TYPE_TRANSFER,
        requestId: await requestId(),
        data: {
          amount: settlementBudget.toFixed(0, BigNumber.ROUND_CEIL),
          protocolData: [{
            protocolName: 'invoiceFulfill',
            contentType: btpPacket.MIME_APPLICATION_JSON,
            data: Buffer.from(JSON.stringify(paymentRequest))
          }]
        }
      }).catch((err) => {
        this.master._log.error(`Error while sending payment request in ` +
          `response to invoice with paymentRequest: ${paymentRequest}: ` +
          `${err}\n` +
          `Balance between accounts will be imbalanced`)
      })
      this.account.payoutAmount =
        this.account.payoutAmount.plus(settlementBudget)
      this.master._log.trace(`Updated balance after settlement with ` +
        `${this.account.lndIdentityPubkey}`)
    } catch (err) {
      this.subBalance(settlementBudget)
      this.master._log.error(`Failed to settle: ${err.message}`)
    }
  }

  public async requestInvoice(): Promise<string> {
    try {
      // request a paymentRequest identifying an invoice from peer
      const response = await this.sendMessage({
        type: btpPacket.TYPE_MESSAGE,
        requestId: await requestId(),
        data: {
          protocolData: [{
            protocolName: 'invoiceRequest',
            contentType: btpPacket.MIME_APPLICATION_JSON,
            data: Buffer.from(JSON.stringify({}))
          }]
        }
      })
      // validate received paymentRequest
      const subProtocol = response.protocolData.find((p: BtpSubProtocol) =>
        p.protocolName === 'invoiceResponse')
      if (subProtocol) {
        const { paymentRequest } = JSON.parse(subProtocol.data.toString())
        await this._validatePaymentRequest(paymentRequest)
        return paymentRequest
      } else {
        throw new Error(`BTP response to requestInvoice did not include ` +
          `invoice data.`)
      }
    } catch (err) {
      throw new Error(`Failed to request invoice: ${err.message}`)
    }
  }

  public handlePrepareResponse(
    preparePacket: IlpPacket.IlpPacket,
    responsePacket: IlpPacket.IlpPacket
  ): void {
    const isFulfill = responsePacket.type === IlpPacket.Type.TYPE_ILP_FULFILL
    const isReject = responsePacket.type === IlpPacket.Type.TYPE_ILP_REJECT
    if (isFulfill) {
      this.master._log.trace(`Received FULFILL response to forwarded PREPARE`)
      const amount = new BigNumber(preparePacket.data.amount)
      try {
        this.subBalance(amount)
        this.account.payoutAmount = this.account.payoutAmount.plus(amount)
      } catch (err) {
        this.master._log.trace(`Failed to fulfill response from PREPARE: ` +
          `${err.message}`)
        throw new IlpPacket.Errors.InternalError(err.message)
      }
    }
    if (isFulfill || (isReject && responsePacket.data.code === 'T04')) {
      this.attemptSettle()
    }
  }

  // Handles incoming BTP.MESSAGE packets
  public async handleData(
    message: BtpPacket,
    dataHandler?: DataHandler
  ): Promise<BtpSubProtocol[]> {
    const peeringRequest = getSubProtocol(message, 'peeringRequest')
    const invoiceRequest = getSubProtocol(message, 'invoiceRequest')
    const ilp = getSubProtocol(message, 'ilp')
    // Upon new WS connection, client sends lightning peering info to server
    if (peeringRequest) {
      const { lndIdentityPubkey, lndPeeringHost } =
        JSON.parse(peeringRequest.data.toString())
      this.master._log.trace(`Peering request received from: ` +
        `${lndIdentityPubkey}@${lndPeeringHost}`)
      return await this._handlePeeringRequest(lndIdentityPubkey, lndPeeringHost)
    }
    // Generate invoice and send paymentRequest back to peer
    if (invoiceRequest) {
      return await this._handleInvoiceRequest()
    }
    // forward ILP prepare packets
    if (ilp && ilp.data[0] === IlpPacket.Type.TYPE_ILP_PREPARE) {
      const { expiresAt, amount } = IlpPacket.deserializeIlpPrepare(ilp.data)
      const amountBN = new BigNumber(amount)
      return await this._handlePrepare(amountBN, expiresAt, dataHandler, ilp)
    }
    return []
  }

  // handles incoming BTP.TRANSFER packets
  public async handleMoney(
    message: BtpPacket,
    moneyHandler?: MoneyHandler
  ): Promise<BtpSubProtocol[]> {
    try {
      const invoiceFulfill = getSubProtocol(message, 'invoiceFulfill')
      if (invoiceFulfill) {
        this.master._log.trace(`Handling paid invoice for account ` +
          `${this.account.lndIdentityPubkey}`)
        const paymentRequest = JSON.parse(invoiceFulfill.data.toString())
        const invoice = await this.master.lnd.getInvoice(paymentRequest)
        const invoiceAmount = this.master.lnd.invoiceAmount(invoice)
        if (this.master.lnd.isFulfilledInvoice(invoice)) {
          this.subBalance(invoiceAmount)
          this.master._log.trace(`Updated balance after settlement with ` +
            `${this.account.lndIdentityPubkey}`)
          if (typeof moneyHandler !== 'function') {
            throw new Error('no money handler registered')
          }
          await moneyHandler(invoiceAmount.toString())
        } else {
          this.master._log.trace(`Payment request does not correspond ` +
            `to a settled invoice`)
        }
      } else {
        this.master._log.trace(`BTP packet did not include 'invoiceFulfill' ` +
          `subprotocol data`)
      }
      return []
    } catch (err) {
      throw new Error(`Failed to handle sent money: ${err.message}`)
    }
  }

  public async disconnect() {
    if (this.master._role === 'client') {
      await this.attemptSettle()
    }
    return this.master._store.unload(`${this.account.accountName}:account`)
  }

  // Handles incoming ILP.PREPARE packets
  private async _handlePrepare(
    amount: BigNumber,
    expiresAt: Date,
    dataHandler: DataHandler | undefined,
    ilp: BtpSubProtocol):
    Promise<BtpSubProtocol[]> {
    try {
      // Ensure registration of dataHandler has been completed
      if (typeof dataHandler !== 'function') {
        throw new Error('no request handler registered')
      }
      // ensure packet is compliant w/ max amount defined in plugin
      if (amount.gt(this.master._maxPacketAmount)) {
        throw new IlpPacket.Errors.AmountTooLargeError(
          'Packet size is too large', {
            receivedAmount: amount.toString(),
            maximumAmount: this.master._maxPacketAmount.toString()
          })
      }
      // update account w/ amount in prepare packet
      try {
        this.addBalance(amount)
      } catch (err) {
        this.master._log.trace(`Failed to forward PREPARE: ${err.message}`)
        throw new IlpPacket.Errors.InsufficientLiquidityError(err.message)
      }
      // timeout if ILP.FULFILL packet is not received before expiry
      let timer: NodeJS.Timer
      const response: Buffer = await Promise.race([
        // timeout promise
        new Promise<Buffer>((resolve) => {
          timer = setTimeout(() => {
            resolve(
              IlpPacket.errorToReject('', {
                ilpErrorCode: 'R00',
                message: `Expired at ${new Date().toISOString()}`
              })
            )
          }, expiresAt.getTime() - Date.now())
        }),
        dataHandler(ilp.data)
      ])
      clearTimeout(timer!)
      if (response[0] === IlpPacket.Type.TYPE_ILP_FULFILL) {
        this.master._log.trace(`Received FULFILL from data handler in ` +
          `response to forwarded PREPARE`)
        // If packet is rejected or times out, revert balance
      } else {
        this.subBalance(amount)
      }
      return ilpAndCustomToProtocolData({ ilp: response })
    } catch (err) {
      return ilpAndCustomToProtocolData(
        { ilp: IlpPacket.errorToReject('', err) }
      )
    }
  }

  private async _handlePeeringRequest(
    lndIdentityPubkey: string,
    lndPeeringHost: string
  ): Promise<BtpSubProtocol[]> {
    try {
      const peers = await this.master.lnd.listPeers()
      const alreadyPeered = peers.find((peer: any) =>
        peer.pub_key === lndIdentityPubkey)
      if (alreadyPeered) {
        this.master._log.trace(`Already lightning peers with: ` +
          `${lndIdentityPubkey}`)
        this.account.lndIdentityPubkey = lndIdentityPubkey
        // send back identity pubkey anyway so peer can store it
        return [{
          protocolName: 'peeringResponse',
          contentType: btpPacket.MIME_APPLICATION_JSON,
          data: Buffer.from(JSON.stringify({
            lndIdentityPubkey: this.master._lndIdentityPubkey
          }))
        }]
        // peer over lightning, send back identity pubkey
      } else {
        this.master._log.trace(`Attempting to connect with peer: ` +
          `${lndIdentityPubkey}`)
        await this.master.lnd.connectPeer(lndIdentityPubkey, lndPeeringHost)
        this.account.lndIdentityPubkey = lndIdentityPubkey
        this.master._log.trace(`Successfully peered with: ${lndIdentityPubkey}`)
        return [{
          protocolName: 'peeringResponse',
          contentType: btpPacket.MIME_APPLICATION_JSON,
          data: Buffer.from(JSON.stringify({
            lndIdentityPubkey: this.master._lndIdentityPubkey
          }))
        }]
      }
    } catch (err) {
      throw new Error(`Failed to add peer: ${err.message}`)
    }
  }

  private async _validatePaymentRequest(
    paymentRequest: string):
    Promise<void> {
    try {
      const invoice = await this.master.lnd.decodePayReq(paymentRequest)
      this._validateInvoiceDestination(invoice)
    } catch (err) {
      throw new Error(`Invalid payment request: ${err.message}`)
    }
  }

  private _validateInvoiceDestination(invoice: any): void {
    if (!(invoice.destination === this.account.lndIdentityPubkey)) {
      throw new Error(`Invoice destination: ${invoice.destination} does not ` +
        `match peer destination: ${this.master._lndIdentityPubkey}`)
    }
  }

  private _validateInvoiceAmount(invoice: any, amt: BigNumber): void {
    const invoiceAmt = new BigNumber(invoice.num_satoshis)
    if (!(invoiceAmt.isEqualTo(amt))) {
      throw new Error(`Invoice amount: ` +
        `${format(invoice.num_satoshis, Unit.Satoshi)} ` +
        `does not match requested amount: ${format(amt, Unit.Satoshi)}`)
    }
  }

  // generate invoice and send back to peer
  private async _handleInvoiceRequest(): Promise<BtpSubProtocol[]> {
    this.master._log.trace(`Received request for invoice`)
    // Retrieve new invoice from lnd client
    const invoice = await this.master.lnd.addInvoice()
    const paymentRequest = invoice.payment_request
    this.master._log.trace(`Responding with paymentRequest: ${paymentRequest}`)
    return [{
      protocolName: 'invoiceResponse',
      contentType: btpPacket.MIME_APPLICATION_JSON,
      data: Buffer.from(JSON.stringify({
        paymentRequest
      }))
    }]
  }

  private addBalance(amount: BigNumber) {
    if (amount.isZero()) {
      return
    }
    if (amount.lt(0)) {
      throw new Error('cannot add negative amount to balance')
    }
    const maximum = this.master._balance.maximum
    const newBalance = this.account.balance.plus(amount)
    if (newBalance.gt(maximum)) {
      throw new Error(`Cannot debit ${format(amount, Unit.Satoshi)} from ` +
        `account ${this.account.lndIdentityPubkey}, proposed balance of ` +
        `${format(newBalance, Unit.Satoshi)} exceeds maximum of ` +
        `${format(maximum, Unit.Satoshi)}`)
    }
    this.account.balance = newBalance
    this.master._log.trace(`Debited ${format(amount, Unit.Satoshi)} ` +
      `from account ${this.account.lndIdentityPubkey}, new balance is ` +
      `${format(newBalance, Unit.Satoshi)}`)
  }

  private subBalance(amount: BigNumber) {
    if (amount.isZero()) {
      return
    }
    if (amount.lt(0)) {
      throw new Error(`cannot subtract negative amount ` +
        `from balance`)
    }
    const minimum = this.master._balance.minimum
    const newBalance = this.account.balance.minus(amount)
    if (newBalance.lt(minimum)) {
      throw new Error(`Cannot credit ${format(amount, Unit.Satoshi)} ` +
        `to account ${this.account.lndIdentityPubkey}, proposedBalance of ` +
        `${format(newBalance, Unit.Satoshi)} is below the minimum of ` +
        `${format(minimum, Unit.Satoshi)}`)
    }
    this.account.balance = newBalance
    this.master._log.trace(`Credited ${format(amount, Unit.Satoshi)} ` +
      `to account ${this.account.lndIdentityPubkey}, ` + ` new balance ` +
      `is ${format(newBalance, Unit.Satoshi)}`)
  }
}
