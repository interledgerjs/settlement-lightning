import BigNumber from 'bignumber.js'
import LndPlugin = require('.')
const BtpPacket = require('btp-packet')
import * as IlpPacket from 'ilp-packet'
import { DataHandler, MoneyHandler } from './utils/types'
import { promisify } from 'util'
import { randomBytes } from 'crypto'
import { BtpPacket, BtpPacketData, BtpSubProtocol } from 'ilp-plugin-btp'
import { Channel } from './utils/lightning-types'
import LndLib from './utils/lndlib'

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
    this.account = {
      isBlocked: false,
      accountName: opts.accountName,
      balance: new BigNumber(0),
    }
    this.master = opts.master
    this.sendMessage = opts.sendMessage
    this.lnd = new LndLib()
  }

  /** Currently unused because we have not implemented balance logic yet. */
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

  /** Unusued */
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

	/* Creates a store for each individual account, then attempts
	 * to connect as peers over the Lightning network */
	async connect() {
    // Setting up account store

    /* Currently untested -- will ensure working in next push
     *
		const accountName = this.account.accountName
    const savedAccount = await this.master._store.loadObject(`account:${accountName}`)

    this.account = new Proxy({
      // concat new account to list of previous accounts
      ...this.account,
      ...savedAccount
    }, {
      set: (account, key, val) => {
        this.master._store.set(accountName, JSON.stringify({
          ...account,
          [key]: val
        }))
        return Reflect.set(account, key, val)
      }
    })
     */

    // Clients initiate the exchange of lnd identity pubkeys
    if (this.master._role === 'client') {
      this.master._log.trace(`Sharing identity pubkey with server.`)
      await this.exchangeIdentityPubkeys()
    }
  }

  /* Send personal identity pubkey to peer*/
  async exchangeIdentityPubkeys(): Promise < void > {
    await this.sendMessage({
      type: BtpPacket.TYPE_MESSAGE,
      requestId: await requestId(),
      data: {
        protocolData: [{
          protocolName: 'info',
          contentType: BtpPacket.MIME_APPLICATION_JSON,
          data: Buffer.from(JSON.stringify({
            lndIdentityPubkey: this.master._lndIdentityPubkey,
            lndPeeringHost: this.master._lndPeeringHost
          }))
        }]
      }
    })
  }


  async attemptSettle() {}

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
    const peeringInfo = getSubProtocol(message, 'info')
    const ilp = getSubProtocol(message, 'ilp') 
    
    // Websocket relationship established, now connect as peers on lightning
    if (peeringInfo) {

      // parse out peer's peering information
      const { lndIdentityPubkey, lndPeeringHost } = JSON.parse(peeringInfo.data.toString())
      
      if (await this.lnd.isPeer(lndIdentityPubkey)) {

        this.master._log.trace(`Peer with lndIdentityPubkey: ${lndIdentityPubkey} is already ` + 
          `connected to account: ${this.account.accountName}`)
        return []

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
        
        /* LND peering relationships are bidirectional, so no
         * need to send back server's identity pubkey */
        return []
      }
    }

    // TODO handle incoming ILP PREPARE packets
    if (ilp) {
      console.log('implement me!')
    }
    return []
  }

  async handleMoney(message: BtpPacket, moneyHandler ? : MoneyHandler): Promise < BtpSubProtocol[] > {
    return []
  }

  beforeForward(preparePacket: IlpPacket.IlpPacket): void {}

  async afterForwardResponse(preparePacket: IlpPacket.IlpPacket, responsePacket: IlpPacket.IlpPacket): Promise < void > {}

  async disconnect() {}
}
