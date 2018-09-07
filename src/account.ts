import BigNumber from 'bignumber.js'
import BtcPlugin = require('.')
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

// Used to track need to settle
enum SettleState {
  NotSettling,
  Settling,
  QueuedSettle
}

// Simple conversion for BTC <-> Satoshi
export const convert = (num: BigNumber.Value, from: Unit, to: Unit): BigNumber =>
  new BigNumber(num).shiftedBy(from - to)

// Prints our debug info nicely
export const format = (num: BigNumber.Value, from: Unit) =>
  convert(num, from, Unit.Satoshi) + ' BTC'

export const requestId = async() =>
  (await promisify(randomBytes)(4)).readUInt32BE(0)

export default class LndAccount {
  // private master: LndPlugin
  private account: {
    settling: SettleState
    isBlocked: boolean
    accountName: string
    balance: BigNumber
    address ? : string
    channelId ? : string
  }
  private master: BtcPlugin
	private sendMessage: (message: BtpPacket) => Promise < BtpPacketData >
  private lnd: LndLib
  constructor(opts: {
    accountName: string,
    master: BtcPlugin,
    sendMessage: (message: BtpPacket) => Promise < BtpPacketData >
  }) {
    this.account = {
      settling: SettleState.NotSettling,
      isBlocked: false,
      accountName: opts.accountName,
      balance: new BigNumber(0)
    }
    this.master = opts.master
    this.sendMessage = opts.sendMessage
    this.lnd = new LndLib()
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

	/* Creates a store for each individual account, then attempts
	 * to connect as peers over the Lightning network */
	async connect() {
		// Setting up account store
		const accountName = this.account.accountName
    const savedAccount = await this.master._store.loadObject(`account:${accountName}`)

    this.account = new Proxy({
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

    // peer over lightning
    		
  }

  /* Retrieve personal identity pubkey and send to peer */
  async shareLndIdentityKey(): Promise < void > {
    const response = await this.sendMessage({
      type: BtpPacket.TYPE_MESSAGE,
      requestId: await requestId(),
      data: {
        protocolData: [{
          protocolName: 'info',
          contentType: BtpPacket.MIME_APPLICATION_JSON,
          data: Buffer.from(JSON.stringify({
            lndIdentityPubkey: this.master._lndIdentityPubkey
          }))
        }]
      }
    })
  }

  linkAddress(info: BtpSubProtocol): void {
    const {
      address
    } = JSON.parse(info.data.toString())

    if (this.account.address) {
      /* for some reason Kincaid's ETH version checks: 
       * if (this.account.address.toLowerCase === address.toLowerCase()) :
       * return True
       * Not sure why that makes a difference if they don't match because he
       * logs the message this address is already linked if not, so I'm not sure
       * what the lowercasing has to do with why we would instead do nothing
       * instead of logging that it already exists */
      return this.master._log.trace(`Cannot link BTC address ${address} to account ` +
        `${this.account.accountName}: ${this.account.address} is already linked`)
    }

    if (validateAddress(address)) {
      this.account.address = address
      this.master._log.trace(`Successfully linked address ${address} to account ${this.account.accountName}`)
    } else {
      this.master._log.trace(`Failed to link address: ${address} is not a valid address`)
    }
  }

		/*
	async fundOutgoingChannel(settlementBudget: BigNumber): Promise < void > {
    let requiresDeposit = false
    let channel: Channel | null

    // Check if channel already exists
    if (typeof (this.account.channel) === 'string') {
      channel = await this._getChannel()
      // if channel does not exist, just create a new one
      if (!channel) return lndlib.createChannel()
      if (settlementBudget.gt(channel.local_balance)) {
        // TODO fund existing channel functionality
      }
    }
	}
		 */

  async attemptSettle() {}

  async handleData(message: BtpPacket, dataHandler ? : DataHandler): Promise < BtpSubProtocol[] > {
    return []
  }

  async handleMoney(message: BtpPacket, moneyHandler ? : MoneyHandler): Promise < BtpSubProtocol[] > {
    return []
  }

  beforeForward(preparePacket: IlpPacket.IlpPacket): void {}

  async afterForwardResponse(preparePacket: IlpPacket.IlpPacket, responsePacket: IlpPacket.IlpPacket): Promise < void > {}

  async disconnect() {}
}
