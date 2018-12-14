import BigNumber from 'bignumber.js'
import debug from 'debug'
import { EventEmitter2 } from 'eventemitter2'
import createLogger from 'ilp-logger'
import { StoreWrapper, MemoryStore } from './utils/store'

import {
  DataHandler,
  Logger,
  MoneyHandler,
  PluginInstance,
  PluginServices
} from './utils/types'

import { registerProtocolNames } from 'btp-packet'
import LightningClientPlugin from './plugins/client'
import LightningServerPlugin from './plugins/server'
import { connectLnd, LightningService, LndOpts } from './utils/lightning'

registerProtocolNames(['peeringRequest', 'invoices'])

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
  // This version only implements Lightning, not BTC directly
  lndIdentityPubkey: string
  // 'host:port' that is listening for P2P lightning connections
  lndHost: string
  // max satoshis permitted in each packet
  peerPort?: string
  maxPacketAmount?: BigNumber.Value
  // lib for calls to lightning daemon
  lnd: LndOpts
}

export = class LightningPlugin extends EventEmitter2 implements PluginInstance {
  public static readonly version = 2
  public lightning: LightningService
  public readonly lndOpts: LndOpts
  public readonly _lndIdentityPubkey: string
  public readonly _lndHost: string
  public readonly _peerPort: string
  public readonly _log: Logger
  public readonly _store: StoreWrapper
  public readonly _role: 'client' | 'server'
  public readonly _maxPacketAmount: BigNumber
  public readonly _balance: {
    minimum: BigNumber
    maximum: BigNumber
    settleTo: BigNumber
    settleThreshold: BigNumber
  }
  private readonly _plugin: LightningServerPlugin | LightningClientPlugin

  constructor(
    {
      role = 'client',
      lndIdentityPubkey,
      lndHost,
      peerPort = '9735',
      maxPacketAmount = Infinity,
      balance: {
        maximum = Infinity,
        settleTo = 0,
        settleThreshold = -Infinity,
        minimum = -Infinity
      } = {},
      lnd,
      ...opts
    }: LightningPluginOpts,
    { log, store = new MemoryStore() }: PluginServices = {}
  ) {
    super()

    // tslint:disable-next-line:strict-type-predicates
    if (typeof lndIdentityPubkey !== 'string') {
      throw new Error(`Lightning identity pubkey required`)
    }

    // tslint:disable-next-line:strict-type-predicates
    if (typeof lndHost !== 'string') {
      throw new Error(`Lightning peering host required`)
    }

    this._lndIdentityPubkey = lndIdentityPubkey
    this._lndHost = lndHost
    this._peerPort = peerPort
    this.lndOpts = lnd

    this._store = new StoreWrapper(store)

    this._log = log || createLogger(`ilp-plugin-lightning-${role}`)
    this._log.trace =
      this._log.trace || debug(`ilp-plugin-lightning-${role}:trace`)

    this._maxPacketAmount = new BigNumber(maxPacketAmount)
      .abs()
      .dp(0, BigNumber.ROUND_DOWN)

    this._balance = {
      maximum: new BigNumber(maximum).dp(0, BigNumber.ROUND_FLOOR),
      settleTo: new BigNumber(settleTo).dp(0, BigNumber.ROUND_FLOOR),
      settleThreshold: new BigNumber(settleThreshold).dp(
        0,
        BigNumber.ROUND_FLOOR
      ),
      minimum: new BigNumber(minimum).dp(0, BigNumber.ROUND_CEIL)
    }

    if (this._balance.settleThreshold.eq(this._balance.minimum)) {
      this._log.trace(
        `Auto-settlement disabled: plugin is in receive-only mode`
      )
    }

    // Validate balance configuration: max >= settleTo >= settleThreshold >= min
    if (!this._balance.maximum.gte(this._balance.settleTo)) {
      throw new Error(
        'Invalid balance configuration: maximum balance must be greater than or equal to settleTo'
      )
    }
    if (!this._balance.settleTo.gte(this._balance.settleThreshold)) {
      throw new Error(
        'Invalid balance configuration: settleTo must be greater than or equal to settleThreshold'
      )
    }
    if (!this._balance.settleThreshold.gte(this._balance.minimum)) {
      throw new Error(
        'Invalid balance configuration: settleThreshold must be greater than or equal to minimum'
      )
    }
    if (!this._balance.maximum.gt(this._balance.minimum)) {
      throw new Error(
        'Invalid balance configuration: maximum balance must be greater than minimum balance'
      )
    }

    const InternalPlugin =
      role === 'client' ? LightningClientPlugin : LightningServerPlugin
    this._plugin = new InternalPlugin(
      {
        ...opts,
        master: this
      },
      { store, log }
    )

    this._plugin.on('connect', () => this.emitAsync('connect'))
    this._plugin.on('disconnect', () => this.emitAsync('disconnect'))
    this._plugin.on('error', e => this.emitAsync('error', e))
  }

  public async connect() {
    this.lightning = await connectLnd(this.lndOpts)
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

  public async sendMoney() {
    this._log.error(
      `sendMoney is not supported: use plugin balance configuration`
    )
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
