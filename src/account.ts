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
  BTC = 9, Satoshi = 0
}

// Simple conversion for BTC <-> Satoshi
export const convert = (num: BigNumber.Value, from: Unit, to: Unit): BigNumber =>
  new BigNumber(num).shiftedBy(from - to)

export const format = (num: BigNumber.Value, from: Unit) =>
  convert(num, from, Unit.Satoshi) + ' BTC'

export const getSubProtocol = (message: BtpPacket, name: string) =>
  message.data.protocolData.find((p: BtpSubProtocol) => p.protocolName === name)

export const requestId = async() =>
  (await promisify(randomBytes)(4)).readUInt32BE(0)

/** Performs functionality for both the server and client plugins. */
export default class LndAccount {

  private account: {
    isBlocked: boolean
    accountName: string
    balance: BigNumber
    payoutAmount: BigNumber
    address ? : string
    channelId ? : string
    lndIdentityPubkey ? : string
  }

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
      isBlocked: false,
      accountName: opts.accountName,
      balance: new BigNumber(0),
      payoutAmount: this.master._balance.settleTo.gt(0) ? new BigNumber(Infinity) : new BigNumber(0)
    }
  }

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

  /*********************** Relationship initialization ****************/

	/* Creates a store for each individual account, then attempts
	 * to connect as peers over the Lightning network */
	async connect() {
    // Setting up account store

    // retrieve account
    const accountKey = `${this.account.accountName}:account`
    await this.master._store.loadObject(accountKey)

    // if account didn't exist, create new empty one
    const savedAccount = this.master._store.getObject(accountKey) || {}

    // If properties exist, convert to BigNumbers
    if (typeof savedAccount.balance === 'string') {
      savedAccount.balance = new BigNumber(savedAccount.balance)
    }
    if (typeof savedAccount.payoutAmount === 'string') {
      savedAccount.payoutAmount = new BigNumber(savedAccount.payoutAmount)
    }

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

  /* Send personal identity pubkey to peer*/
  async sendPeeringInfo(): Promise < void > {
    // TODO check for existing peers and see if we are already connected
    await this.sendMessage({
      type: BtpPacket.TYPE_MESSAGE,
      requestId: await requestId(),
      data: {
        protocolData: [{
          protocolName: 'peeringInfo',
          contentType: BtpPacket.MIME_APPLICATION_JSON,
          data: Buffer.from(JSON.stringify({
            lndIdentityPubkey: this.master._lndIdentityPubkey,
            lndPeeringHost: this.master._lndPeeringHost
          }))
        }]
      }
    })
  }

  /** LND peering relationships are bidirectional, so no
  * need to send back server's identity pubkey */
  async peer(lndIdentityPubkey: string, lndPeeringHost: string) : Promise < void > {
    if (await this.lnd.isPeer(lndIdentityPubkey)) {
      this.master._log.trace(`Peer with lndIdentityPubkey: ${lndIdentityPubkey} is already ` + 
        `connected to account: ${this.account.accountName}`)
    } else {
      this.master._log.trace(`No pre-existing lightning peer relationship.  Attempting to ` +
        `peer now.`)
      await this.lnd.connectPeer(lndIdentityPubkey, lndPeeringHost)
      // ensure peering success
      if (await this.lnd.isPeer(lndIdentityPubkey)) {
        this.master._log.trace(`Successfully peered over lightning.`)
      } else {
        throw new Error(`connectPeer failed to add peer!`)
      }
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
      
      const shouldSettle = settleThreshold.gt(this.account.balance)
      // determine if we need to settle
      if (!shouldSettle) {
        return this.master._log.trace(`Should not settle.  Balance of ` + 
          `${format(this.account.balance, Unit.Satoshi)} is not below ` +
          `settleThreshold of ${format(settleThreshold, Unit.Satoshi)}`)
      }

      const settlementAmount = this.master._balance.settleTo.minus(this.account.balance)

      this.master._log.trace(`Attempting to settle with account ` + 
        `${this.account.accountName} for ${format(settlementAmount, Unit.Satoshi)}`)

      const paymentRequest = await this.requestInvoice(settlementAmount)
      this.validateInvoice(paymentRequest, settlementAmount)
      // TODO implement a check to ensure we have enough funds in channel
      // conencted to lightning network to actually pay amount for invoice
      const paymentPreimage = await this.lnd.payInvoice(paymentRequest)

      //TODO send transfer packet to peer confirming payment
      this.sendMessage({
        type: BtpPacket.TYPE_TRANSFER,
        requestId: await requestId(),
        data: {
          amount: settlementAmount.toFixed(0, BigNumber.ROUND_CEIL),
          protocolData: [{
            // TODO better name?
            protocolName: 'paidInvoice',
            contentType: BtpPacket.MIME_APPLICATION_JSON,
            data: Buffer.from(JSON.stringify(paymentPreimage))
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

  /** Ensures received invoice matches the requested destination 
   * and payment amount */
  async validateInvoice(paymentRequest: string, amt: BigNumber) : Promise < void > {
    const decodedInvoice = await this.lnd.decodePayReq(paymentRequest)
     
    const invoiceDestination = decodedInvoice.destination 
    if (invoiceDestination !== this.master._lndIdentityPubkey) {
      throw new Error(`Invoice destination: ${invoiceDestination} does not ` +
        `match peer destination: ${this.master._lndIdentityPubkey}`)
    }

    const invoiceAmt = decodedInvoice.num_satoshis
    if (invoiceAmt !== amt) {
      throw new Error(`Invoice amount: ${format(invoiceAmt, Unit.Satoshi)} ` +
        `does not match requested amount: ${format(amt, Unit.Satoshi)}`)
    }
  }

  /* Ask peer to generate invoice that you can fulfill */ 
  async requestInvoice(amt: BigNumber): Promise < string > {
    // TODO make timeout race
    const response = await this.sendMessage({
      type: BtpPacket.TYPE_MESSAGE,
      requestId: await requestId(),
      data: {
        protocolData: [{
          protocolName: 'invoice',
          contentType: BtpPacket.MIME_APPLICATION_JSON,
          data: Buffer.from(JSON.stringify({
            amount: amt
          }))
        }]
      }
    })
    const subProtocol = response.protocolData.find((p: BtpSubProtocol) => p.protocolName === 'invoice')
    if (subProtocol) {
      const { paymentRequest } = JSON.parse(subProtocol.data.toString())
      return paymentRequest
    } else {
      throw new Error('BTP response to requestInvoice did not include invoice data.')
    }
  }

  /** Accept an amount to create an invoice and format the
   * response as a protocolData to send back to the user
   * that requested the invoice */
  async handleInvoiceRequest(amt: number) : Promise < any > {
    // Retrieve new invoice from lnd client
    const invoice = await this.lnd.addInvoice(amt)
    const paymentRequest = invoice['payment_request']
    this.master._log.trace(`Received request for invoice of size: ${amt}`)
    this.master._log.trace(`Responding with paymentRequest: ${paymentRequest}`)
    // format response invoice packet containing the payment request
    return [{
      protocolName: 'invoice',
      contentType: BtpPacket.MIME_APPLICATION_JSON,
      data: Buffer.from(JSON.stringify({
        paymentRequest: paymentRequest
      }))
    }]
  }

  /************************** Handlers ****************************/

  /** Handles peering requests and ILP PREPARE requests.
   * Peering:
   * When a client establishes a connection to a server they send their
   * lndIdentityPubkey and lndPeeringHost to the server.  The server then
   * makes a lightning peering request using that information.
   *
   * Why are we not opening payment channels?
   * In this implementation we are leaving that as out of scope.  We are
   * operating under the assumption that as long as both client and server
   * have a channel connected to the greater lightning network that the 
   * routing protocol implemented in lightning will take care of ensuring
   * the payment can be sent.
   *
   * In future implementations we will open a channel between the client and
   * server.  Hopefully both the server and client will already be connected to the
   * greater lightning network before this so we can make payments while the BTC
   * blockchain opens the payment channel between the two.
   *
   * Opening channels directly to connectors:
   * Benefits: connectors will become hubs in the lightning network to route
   * payments more efficiently and ensure sufficient liquidity for larger
   * payments
   *
   * Downsides: BTC is very slow, so having liquidity tied up in n payment
   * makes the connector less responsive in case it needs to adjust it's
   * liquidity.
   *
   * ILP PREPARE:
   * TODO
   */
  async handleData(message: BtpPacket, dataHandler ? : DataHandler): Promise < BtpSubProtocol[] > {
    const peeringInfo = getSubProtocol(message, 'peeringInfo')
    const ilp = getSubProtocol(message, 'ilp') 
    const invoice = getSubProtocol(message, 'invoice')

    // Websocket relationship established, now connect as peers on lightning
    if (peeringInfo) {
      // parse out peer's peering information
      const { lndIdentityPubkey, lndPeeringHost } = JSON.parse(peeringInfo.data.toString())
      this.master._log.trace(`Peering request received from ${lndIdentityPubkey}`)
      await this.peer(lndIdentityPubkey, lndPeeringHost)
    }

    /* parse subProtocol for amount, generate new lightning invoice for that amount,
     * respond with paymentRequest corresponding to generated invoice */
    if (invoice) {
      const { amount } = JSON.parse(invoice.data.toString())
      return await this.handleInvoiceRequest(amount)
    }

    // TODO handle incoming ILP PREPARE packets
    if (ilp && ilp.data[0] === IlpPacket.Type.TYPE_ILP_PREPARE) {
      try {
        const { expiresAt, amount } = IlpPacket.deserializeIlpPrepare(ilp.data)
        const amountBN = new BigNumber(amount)
        
        // Ensure registration of dataHandler has been completed
        if (typeof dataHandler !== 'function') {
          throw new Error('no request handler registered')
        }
        // ensure packet is compliant w/ max amount plugin defined as willing to accept
        if (amountBN.gt(this.master._maxPacketAmount)) {
          throw new IlpPacket.Errors.AmountTooLargeError('Packet size is too large', {
            receivedAmount: amount,
            maximumAmount: this.master._maxPacketAmount.toString()
          })
        }
        // Pass along packet and update balances
        return await this.handlePrepare(amountBN, expiresAt, dataHandler, ilp) 
      } catch (err) {
        return ilpAndCustomToProtocolData({ ilp: IlpPacket.errorToReject('', err)})
      }
    }
    return []
  }

  // TODO update expiresAt and return types
  async handlePrepare(amount: BigNumber, expiresAt: Date, dataHandler: DataHandler, ilp: BtpSubProtocol) : Promise < any > {
    // update account w/ amount in packet
    try { 
      this.addBalance(amount)
    } catch (err) {
      this.master._log.trace(`Failed to forward PREPARE: ${err.message}`)
      throw new IlpPacket.Errors.InsufficientLiquidityError(err.message)
    }

    // Pass along packet, and ensure it doesn't expire
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
      // promise waiting for returned packet
      dataHandler(ilp.data)
    ])
    clearTimeout(timer!)

    // If packet is rejected, revert balance
    if (response[0] === IlpPacket.Type.TYPE_ILP_REJECT) {
      this.subBalance(amount)
    } else if (response[0] === IlpPacket.Type.TYPE_ILP_FULFILL) {
      this.master._log.trace('Received FULFILL from data handler in response to forwarded PREPARE')
    }
    return ilpAndCustomToProtocolData({ ilp : response })
  }

  handlePrepareResponse (preparePacket: IlpPacket.IlpPacket, responsePacket: IlpPacket.IlpPacket) : void {
    if (responsePacket.type !== IlpPacket.Type.TYPE_ILP_FULFILL) return

    this.master._log.trace('Received FULFILL in response to forwarded PREPARE')

    let amount = new BigNumber(preparePacket.data.amount)
    try {
      this.subBalance(amount)
      this.attemptSettle()
    } catch (err) {
      throw new IlpPacket.Errors.InsufficientLiquidityError(err.message)
    }
  }

  async handleMoney(message: BtpPacket, moneyHandler ? : MoneyHandler): Promise < BtpSubProtocol[] > {
    try {
      const paidInvoice = getSubProtocol(message, 'paidInvoice')
      if (paidInvoice) {
        this.master._log.trace(`Handling paid invoice for account ${this.account.accountName}`)
        const paymentPreimage = JSON.parse(paidInvoice.data.toString())
          
        const payment = await this.lnd.getFulfilledPayment(paymentPreimage)

        if (payment) {
          this.subBalance(payment.value)
        } else {
          this.master._log.trace('Payment preimage does not correspond to any fulfilled payments') 
        }
      } else {
        this.master._log.trace(`BTP packet did not include 'paidInvoice' subprotocol data`)
      }
      return []
    } catch (err) {
      throw new Error(`Failed to handle sent money: ${err.message}`)
    }
  }

  beforeForward(preparePacket: IlpPacket.IlpPacket): void {}

  async afterForwardResponse(preparePacket: IlpPacket.IlpPacket, responsePacket: IlpPacket.IlpPacket): Promise < void > {}

  async disconnect() {}
}
