import BigNumber from 'bignumber.js'
import * as debug from 'debug'
import { EventEmitter2 } from 'eventemitter2'
import createLogger from 'ilp-logger'
import StoreWrapper from './utils/store-wrapper'

import {
  DataHandler,
  Logger,
  MoneyHandler,
  PluginInstance
} from './utils/types'

import * as IlpPacket from 'ilp-packet'
import BtpPlugin, { BtpPacket, BtpSubProtocol } from 'ilp-plugin-btp'

import LightningAccount, { convert, requestId, Unit } from './account'
import LightningClientPlugin from './plugins/client'
import LightningServerPlugin from './plugins/server'
import LightningLib from './utils/lightning-lib'

interface LightningPluginOpts {

  // directs whether master plugin behaves as client or server
  role: 'client' | 'server'
  // tracks credit relationship with counterparty
  balance?: {
    minimum?: BigNumber.Value
    maximum?: BigNumber.Value
    settleTo?: BigNumber.Value
    settleThreshold?: BigNumber.Value
  }
  _store?: any
  _log?: Logger
  // This version only implements Lightning, not BTC directly
  lndIdentityPubkey: string
  // 'host:port' that is listening for P2P lightning connections
  lndPeeringHost: string
  // max satoshis permitted in each packet
  maxPacketAmount?: BigNumber.Value
  // lib for calls to lightning daemon
  lnd: LightningLib
}

export = class LightningPlugin extends EventEmitter2 implements PluginInstance {
  public readonly lnd: LightningLib
  public readonly _lndIdentityPubkey: string
  public readonly _lndPeeringHost: string
  public readonly _log: Logger
  public readonly _store: any
  public readonly _role: 'client' | 'server'
  public readonly _maxPacketAmount: BigNumber
  public readonly _balance: {
    minimum: BigNumber
    maximum: BigNumber
    settleTo: BigNumber
    settleThreshold?: BigNumber
  }
  private readonly _plugin: LightningServerPlugin | LightningClientPlugin
  private readonly version = 2

  constructor({
    role = 'client',
    lndIdentityPubkey,
    lndPeeringHost,
    maxPacketAmount = Infinity,
    balance: {
      minimum = -Infinity,
      maximum = Infinity,
      settleTo = 0,
      settleThreshold = -100000
    } = {}, ...opts
  }: LightningPluginOpts) {
    super()
    // unable to peer to counterparty without these credentials
    if (typeof lndIdentityPubkey !== 'string') {
      throw new Error(`Lightning identity pubkey required`)
    }
    if (typeof lndPeeringHost !== 'string') {
      throw new Error(`Lightning peering host required`)
    }

    this._role = role
    this._store = new StoreWrapper(opts._store)
    this._maxPacketAmount = new BigNumber(maxPacketAmount).abs()
      .dp(0, BigNumber.ROUND_DOWN)
    // logging tools
    this._log = opts._log || createLogger(`ilp-plugin-lnd-${this._role}`)
    this._log.trace = this._log.trace ||
      debug(`ilp-plugin-lnd-${this._role}:trace`)
    // lightning peering credentials
    this._lndIdentityPubkey = lndIdentityPubkey
    this._lndPeeringHost = lndPeeringHost
    this.lnd = new LightningLib({
      ...opts
    })

    // create server or client plugin
    const internalPlugin = this._role === 'client' ?
      LightningClientPlugin : LightningServerPlugin
    this._plugin = new internalPlugin({
      ...opts,
      master: this
    })

    this._balance = {
      minimum: new BigNumber(minimum).dp(0, BigNumber.ROUND_FLOOR),
      maximum: new BigNumber(maximum).dp(0, BigNumber.ROUND_FLOOR),
      settleTo: new BigNumber(settleTo).dp(0, BigNumber.ROUND_FLOOR),
      settleThreshold: settleThreshold ?
        new BigNumber(settleThreshold).dp(0, BigNumber.ROUND_FLOOR) : undefined
    }
    if (this._balance.settleThreshold) {
      if (!this._balance.maximum.gte(this._balance.settleTo)) {
        throw new Error(`Invalid balance configuration: ` +
          `maximum balance must be greater than or equal to settleTo`)
      }
      if (!this._balance.settleTo.gte(this._balance.settleThreshold)) {
        throw new Error(`Invalid balance configuration: ` +
          `settleTo mustbe greater than or equal to settleThreshold`)
      }
      if (!this._balance.settleThreshold.gte(this._balance.minimum)) {
        throw new Error(`Invalid balance configuration: ` +
          `must be greater than or equal to minimum balance`)
      }
    } else {
      if (!this._balance.maximum.gt(this._balance.minimum)) {
        throw new Error(`Invalid balance configuration: ` +
          `maximum balance must be greater than minimum balance`)
      }
    }

    this._plugin.on('connect', () => this.emitAsync('connect'))
    this._plugin.on('disconnect', () => this.emitAsync('disconnect'))
    this._plugin.on('error', (e) => this.emitAsync('error', e))
  }

  public async connect() {
    return this._plugin.connect()
  }

  public async disconnect() {
    await this._store.close()
    return this._plugin.disconnect()
  }

  public isConnected() {
    return this._plugin.isConnected()
  }

  public async sendData(data: Buffer) {
    return this._plugin.sendData(data)
  }

  public async sendMoney(amount: string) {
    this._log.error(`sendMoney is not supported: use plugin balance ` +
      `configuration instead of connector balance for settlement`)
  }

  public registerDataHandler(dataHandler: DataHandler) {
    return this._plugin.registerDataHandler(dataHandler)
  }

  public deregisterDataHandler() {
    return this._plugin.deregisterDataHandler()
  }

  public registerMoneyHandler(moneyHandler: MoneyHandler) {
    return this._plugin.registerMoneyHandler(moneyHandler)
  }

  public deregisterMoneyHandler() {
    return this._plugin.deregisterMoneyHandler()
  }
}
