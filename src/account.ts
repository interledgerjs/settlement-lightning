import BigNumber from 'bignumber.js'
import LndPlugin = require('.')
const BtpPacket = require('btp-packet')
import * as IlpPacket from 'ilp-packet'
import { DataHandler, MoneyHandler } from './utils/types'
import { promisify } from 'util'
import { randomBytes } from 'crypto'
import { BtpPacket, BtpPacketData, BtpSubProtocol } from 'ilp-plugin-btp'
import LndLib from './utils/lndlib'
import { ilpAndCustomToProtocolData } from 'ilp-plugin-btp/src/protocol-data-converter'

// Used to denominate which assetScale we are using
export enum Unit {
  BTC = 8, Satoshi = 0
}

// Simple conversion for BTC <-> Satoshi
export const convert = (num: BigNumber.Value, from: Unit, to: Unit): BigNumber =>
  new BigNumber(num).shiftedBy(from - to)

export const format = (num: BigNumber.Value, from: Unit) =>
  convert(num, from, Unit.Satoshi) + ' Satoshis'

export const getSubProtocol = (message: BtpPacket, name: string) =>
  message.data.protocolData.find((p: BtpSubProtocol) => p.protocolName === name)

export const requestId = async() =>
  (await promisify(randomBytes)(4)).readUInt32BE(0)

/** Performs functionality for both the server and client plugins. */
export default class LndAccount {
  private account: {
    accountName: string
    balance: BigNumber
    lndIdentityPubkey ? : string
  }
  // top level plugin
  private master: LndPlugin
  // method in which BTP packets will be sent
  private sendMessage: (message: BtpPacket) => Promise < BtpPacketData >
  // All lightning logic is performed using LndLib
  private lnd: LndLib
  constructor(opts: {
    accountName: string,
    master: LndPlugin,
    sendMessage: (message: BtpPacket) => Promise < BtpPacketData >
  }) {
    this.master = opts.master
    this.lnd = new LndLib()
    this.sendMessage = opts.sendMessage
    this.account = {
      accountName: opts.accountName,
      balance: new BigNumber(0),
    }
  }

  /*********************** Relationship initialization ****************/

	/* Creates a store for each individual account, then attempts
	 * to connect as peers over the Lightning network */
	async connect() {
    // retrieve account
    const accountKey = `${this.account.accountName}:account`
    await this.master._store.loadObject(accountKey)
    const savedAccount = this.master._store.getObject(accountKey) || {}
    // If properties exist, convert to BigNumbers
    if (typeof savedAccount.balance === 'string') {
      savedAccount.balance = new BigNumber(savedAccount.balance)
    }
    // load account class variable
    this.account = new Proxy({
      // concat new account to list of previous accounts
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

  /*********************** Lightning peering ***********************/

  /* Send personal identity pubkey to server*/
  async sendPeeringInfo(): Promise < void > {
    if (this.account.lndIdentityPubkey) {
      if (this.lnd.isPeer(this.account.lndIdentityPubkey)) {
        this.master._log.trace(`Already peered with : ${this.account.lndIdentityPubkey}`)
        return
      }
    }
    // if not already peered, share peering host and identity pubkey
    const response = await this.sendMessage({
      type: BtpPacket.TYPE_MESSAGE,
      requestId: await requestId(),
      data: {
        protocolData: [{
          protocolName: 'peeringRequest',
          contentType: BtpPacket.MIME_APPLICATION_JSON,
          data: Buffer.from(JSON.stringify({
            lndIdentityPubkey: this.master._lndIdentityPubkey,
            lndPeeringHost: this.master._lndPeeringHost
          }))
        }]
      }
    })
    const subProtocol = response.protocolData.find((p: BtpSubProtocol) => p.protocolName === 'peeringResponse')
    if (subProtocol) {
      const { lndIdentityPubkey } = JSON.parse(subProtocol.data.toString())
      if (!this.lnd.isPeer(lndIdentityPubkey)) {
        throw new Error(`Received peeringResponse without existing peer relationship over lightning`)
      }
      this.account.lndIdentityPubkey = lndIdentityPubkey
      this.master._log.trace(`Succesfully peered with server over lightning.`)
    } else {
      throw new Error(`Received improper response to peeringRequest`)
    }
  }

  /** LND peering relationships are bidirectional, so no
  * need to send back server's identity pubkey */
  async handlePeeringRequest(lndIdentityPubkey: string, lndPeeringHost: string) : Promise < BtpSubProtocol[] > {
    try {
      const peers = await this.lnd.listPeers()
      const alreadyPeered = peers.find((peer: any) => peer.pub_key === lndIdentityPubkey)
      if (alreadyPeered) {
        this.master._log.trace(`Already lightning peers with: ${lndIdentityPubkey}`)
        return [{
          protocolName: 'peeringResponse',
          contentType: BtpPacket.MIME_APPLICATION_JSON,
          data: Buffer.from(JSON.stringify({
            lndIdentityPubkey: this.master._lndIdentityPubkey
          }))
        }]
        // if not peered, connect over lightning
      } else {
        this.master._log.trace(`Attempting to connect with peer: ${lndIdentityPubkey}`)
        await this.lnd.connectPeer(lndIdentityPubkey, lndPeeringHost)
        this.master._log.trace(`Successfully peered with: ${lndIdentityPubkey}`)
        return [{
          protocolName: 'peeringResponse',
          contentType: BtpPacket.MIME_APPLICATION_JSON,
          data: Buffer.from(JSON.stringify({
            lndIdentityPubkey: this.master._lndIdentityPubkey
          }))
        }]
      } 
      
    } catch (err) {
      throw new Error(`Failed to add peer: ${err.message}`)
    }
  }

  /********************** Settlement functionality ***********************/

  async attemptSettle(): Promise < void > {
    const settleThreshold = this.master._balance.settleThreshold
    try {
      // Check if receive only mode is on
      if (!settleThreshold) {
        return this.master._log.trace('Cannot settle. Settle threshold is undefined')
      }
      // determine if we need to settle
      const shouldSettle = settleThreshold.gt(this.account.balance)
      if (!shouldSettle) {
        return this.master._log.trace(`Should not settle.  Balance of ` + 
          `${format(this.account.balance, Unit.Satoshi)} is not below ` +
          `settleThreshold of ${format(settleThreshold, Unit.Satoshi)}`)
      }
      const settlementAmount = this.master._balance.settleTo.minus(this.account.balance)
      if (!this.lnd.hasAmount(settlementAmount)) {
        return this.master._log.trace(`Cannot settle.  Insufficient ` + 
          `funds in channel to complete settlement of ` + 
          `${format(settlementAmount, Unit.Satoshi)}`)
      }
      this.master._log.trace(`Attempting to settle with account ` + 
        `${this.account.accountName} for ${format(settlementAmount, Unit.Satoshi)}`)
      // Request invoice, pay invoice
      const paymentRequest = await this.requestInvoice(settlementAmount)
      await this.lnd.payInvoice(paymentRequest)
      // Send notification of payment
      this.sendMessage({
        type: BtpPacket.TYPE_TRANSFER,
        requestId: await requestId(),
        data: {
          amount: settlementAmount.toFixed(0, BigNumber.ROUND_CEIL),
          protocolData: [{
            protocolName: 'invoiceFulfill',
            contentType: BtpPacket.MIME_APPLICATION_JSON,
            data: Buffer.from(JSON.stringify(paymentRequest))
          }]
        }
      }).catch(err => {
        this.master._log.error(`Error while sending payment preimage in ` + 
          `response to invoice with paymentRequest: ${paymentRequest}, ` +
          `balance between accounts will be imbalanced`)
      })
    } catch (err) {
      this.master._log.error(`Failed to settle: ${err.message}`)
    }
  }

  /***************** Invoice logic *******************/

  // Ask peer to generate invoice 
  async requestInvoice(amt: BigNumber): Promise < string > {
    try {
      // request a paymentRequest identifying an invoice from peer
      const response = await this.sendMessage({
        type: BtpPacket.TYPE_MESSAGE,
        requestId: await requestId(),
        data: {
          protocolData: [{
            protocolName: 'invoiceRequest',
            contentType: BtpPacket.MIME_APPLICATION_JSON,
            data: Buffer.from(JSON.stringify({
              amount: amt
            }))
          }]
        }
      })
      // validate received paymentRequest
      const subProtocol = response.protocolData.find((p: BtpSubProtocol) => p.protocolName === 'invoiceResponse')
      if (subProtocol) {
        const { paymentRequest } = JSON.parse(subProtocol.data.toString())
        try {
          await this.validatePaymentRequest(paymentRequest, amt)
          return paymentRequest
        } catch (err) {
          throw new Error(`Requested invoice is invalid: ${err.message}`)
        }
      } else {
        throw new Error('BTP response to requestInvoice did not include invoice data.')
      }
    } catch (err) {
      this.master._log.trace(`Failed to request invoice: ${err.message}`)
      return ''
    }
  }

  async validatePaymentRequest(paymentRequest: string, amt: BigNumber) : Promise < void > {
    const invoice = await this.lnd.decodePayReq(paymentRequest)
    // TODO instead of validating, we can just specify amt (satoshis) and
    // dest_string (identity pubkey) in sendPayment request to lnd
    this.validateInvoiceDestination(invoice)
    this.validateInvoiceAmount(invoice, amt)
  }

  validateInvoiceDestination(invoice: any) : void {
    if (!(invoice.destination == this.account.lndIdentityPubkey)) {
      throw new Error(`Invoice destination: ${invoice.destination} does not ` +
        `match peer destination: ${this.master._lndIdentityPubkey}`)
    }
  }

  validateInvoiceAmount(invoice: any, amt: BigNumber) : void {
    if (!(invoice.num_satoshis == amt)) {
      throw new Error(`Invoice amount: ${format(invoice.num_satoshis, Unit.Satoshi)} ` +
        `does not match requested amount: ${format(amt, Unit.Satoshi)}`)
    }
  }

  // generate invoice and send back to peer
  async handleInvoiceRequest(amt: number) : Promise < BtpSubProtocol[] > {
    this.master._log.trace(`Received request for invoice of size: ${amt}`)
    // Retrieve new invoice from lnd client
    const invoice = await this.lnd.addInvoice(amt)
    const paymentRequest = invoice['payment_request']
    this.master._log.trace(`Responding with paymentRequest: ${paymentRequest}`)
    return [{
      protocolName: 'invoiceResponse',
      contentType: BtpPacket.MIME_APPLICATION_JSON,
      data: Buffer.from(JSON.stringify({
        paymentRequest: paymentRequest
      }))
    }]
  }

  /************************** ILP packet handlers ***************************/


  // Handles incoming ILP.PREPARE packets
  async handlePrepare(amount: BigNumber, expiresAt: Date, dataHandler: DataHandler | undefined, ilp: BtpSubProtocol) : Promise < BtpSubProtocol[] > {
    try {
      // Ensure registration of dataHandler has been completed
      if (typeof dataHandler !== 'function') {
        throw new Error('no request handler registered')
      }
      // ensure packet is compliant w/ max amount plugin defined as willing to accept
      if (amount.gt(this.master._maxPacketAmount)) {
        throw new IlpPacket.Errors.AmountTooLargeError('Packet size is too large', {
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
      let response: Buffer = await Promise.race([
        // timeout promise
        new Promise<Buffer>(resolve => {
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
      // If packet is rejected or times out, revert balance
      if (response[0] === IlpPacket.Type.TYPE_ILP_FULFILL) {
        this.master._log.trace('Received FULFILL from data handler in response to forwarded PREPARE')
      } else {
        this.subBalance(amount)
      }
      return ilpAndCustomToProtocolData({ ilp : response })
    } catch (err) {
      return ilpAndCustomToProtocolData({ ilp: IlpPacket.errorToReject('', err)})
    }
  }

  handlePrepareResponse (preparePacket: IlpPacket.IlpPacket, responsePacket: IlpPacket.IlpPacket) : void {
    const isFulfill = responsePacket.type === IlpPacket.Type.TYPE_ILP_FULFILL
    const isReject = responsePacket.type === IlpPacket.Type.TYPE_ILP_REJECT
    if (isFulfill) {
      this.master._log.trace(`Received FULFILL in response to forwarded PREPARE`)
      const amount = new BigNumber(preparePacket.data.amount)
      try {
        this.subBalance(amount)
      } catch (err) {
        this.master._log.trace(`Failed to fulfill response from PREPARE: ${err.message}`)
        throw new IlpPacket.Errors.InternalError(err.message)
      }
    }
    if (isFulfill || (isReject && responsePacket.data.code === 'T04')) this.attemptSettle()
  }

  /************************** BTP packet handlers ****************************/

  // Handles incoming BTP.MESSAGE packets
  async handleData(message: BtpPacket, dataHandler ? : DataHandler): Promise < BtpSubProtocol[] > {
    const peeringRequest = getSubProtocol(message, 'peeringRequest')
    const invoiceRequest = getSubProtocol(message, 'invoiceRequest')
    const ilp = getSubProtocol(message, 'ilp') 
    // Upon new WS connection, client sends lightning peering info to server
    if (peeringRequest) {
      const { lndIdentityPubkey, lndPeeringHost } = JSON.parse(peeringRequest.data.toString())
      this.master._log.trace(`Peering request received from ${lndIdentityPubkey}`)
      return await this.handlePeeringRequest(lndIdentityPubkey, lndPeeringHost)
    }
    // Generate invoice and send paymentRequest back to peer
    if (invoiceRequest) {
      const { amount } = JSON.parse(invoiceRequest.data.toString())
      return await this.handleInvoiceRequest(amount)
    }
    // Handles ILP prepare packets
    if (ilp && ilp.data[0] === IlpPacket.Type.TYPE_ILP_PREPARE) {
      const { expiresAt, amount } = IlpPacket.deserializeIlpPrepare(ilp.data)
      const amountBN = new BigNumber(amount)
      return await this.handlePrepare(amountBN, expiresAt, dataHandler, ilp) 
    }
    return []
  }

  // handles incoming BTP.TRANSFER packets
  async handleMoney(message: BtpPacket, moneyHandler ? : MoneyHandler): Promise < BtpSubProtocol[] > {
    try {
      const invoiceFulfill = getSubProtocol(message, 'invoiceFulfill')
      if (invoiceFulfill) {
        this.master._log.trace(`Handling paid invoice for account ${this.account.accountName}`)
        // check validity through matching sent preimage to fulfilled invoice
        const paymentRequest = JSON.parse(invoiceFulfill.data.toString())
        const invoice = await this.lnd.getInvoice(paymentRequest)
        if (this.lnd.isFulfilledInvoice(invoice)) {
          this.subBalance(this.lnd.invoiceAmount(invoice))
          this.master._log.trace(`Updated balance after settlement with ${this.account.accountName}`)
        } else {
          this.master._log.trace('Payment request does not correspond to a settled invoice') 
        }
      } else {
        this.master._log.trace(`BTP packet did not include 'invoiceFulfill' subprotocol data`)
      }
      return []
    } catch (err) {
      throw new Error(`Failed to handle sent money: ${err.message}`)
    }
  }

  async disconnect() {
    if (this.master._role === 'client') {
      await this.attemptSettle()
    }
    return this.master._store.unload(`${this.account.accountName}:account`)
  }

  /*********** Balance adjustment logging and error checking ************/

  addBalance(amount: BigNumber) {
    if (amount.isZero()) return
    if (amount.lt(0)) throw new Error('cannot add negative amount to balance')
    const maximum = this.master._balance.maximum
    const newBalance = this.account.balance.plus(amount)
    if (newBalance.gt(maximum)) {
      throw new Error(`Cannot debit ${format(amount, Unit.Satoshi)} from account ${this.account.accountName}, ` +
        `proposed balance of ${format(newBalance, Unit.Satoshi)} exceeds maximum of ${format(maximum, Unit.Satoshi)}`)
    }
    this.master._log.trace(`Debited ${format(amount, Unit.Satoshi)} from account ${this.account.accountName}, new balance is ${format(newBalance, Unit.Satoshi)}`)
  }

  subBalance(amount: BigNumber) {
    if (amount.isZero()) return
    if (amount.lt(0)) throw new Error('cannot subtract negative amount from balance')
    const minimum = this.master._balance.minimum
    const newBalance = this.account.balance.minus(amount)
    if (newBalance.lt(minimum)) {
      throw new Error(`Cannot credit ${format(amount, Unit.Satoshi)} to account ${this.account.accountName}, ` +
        `proposedBalance of ${format(newBalance, Unit.Satoshi)} is below the minimum of ${format(minimum, Unit.Satoshi)}`)
      this.master._log.trace(`Credited ${format(amount, Unit.Satoshi)} to account ${this.account.accountName}, ` + ` new balance is ${format(newBalance, Unit.Satoshi)}`)
      this.account.balance = newBalance
    }
  }
}
