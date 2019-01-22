import LightningAccount from './account'
import BigNumber from 'bignumber.js'
import { registerProtocolNames } from 'btp-packet'
import debug from 'debug'
import { EventEmitter2 } from 'eventemitter2'
import createLogger from 'ilp-logger'
import { BtpPacket, IlpPluginBtpConstructorOptions } from 'ilp-plugin-btp'
import { LightningClientPlugin } from './plugins/client'
import { LightningServerPlugin, MiniAccountsOpts } from './plugins/server'
import {
  connectLnd,
  LndService,
  LndOpts,
  waitForReady,
  PaymentStream,
  InvoiceStream,
  createPaymentStream,
  createInvoiceStream
} from './lightning'
import { MemoryStore } from './utils/store'
import {
  DataHandler,
  Logger,
  MoneyHandler,
  PluginInstance,
  PluginServices,
  Store
} from './types/plugin'
import { BehaviorSubject } from 'rxjs'

// Re-export Lightning related-services
export * from './lightning'
export { LightningAccount }

registerProtocolNames(['peeringRequest', 'paymentRequest'])

// TODO Should the default handlers return ILP reject packets?

const defaultDataHandler: DataHandler = () => {
  throw new Error('no request handler registered')
}

const defaultMoneyHandler: MoneyHandler = () => {
  throw new Error('no money handler registered')
}

export interface LightningPluginOpts
  extends MiniAccountsOpts,
    IlpPluginBtpConstructorOptions {
  // lib for calls to lightning daemon
  lnd: LndOpts | LndService
  // directs whether master plugin behaves as client or server
  role: 'client' | 'server'
  // Maximum allowed amount in gwei for incoming packets (gwei)
  maxPacketAmount?: BigNumber.Value
  // Balance (positive) is amount in gwei the counterparty owes this instance
  // (negative balance implies this instance owes the counterparty)
  // Debits add to the balance; credits subtract from the balance
  // maximum >= settleTo > settleThreshold >= minimum (gwei)
  balance?: {
    // Maximum balance counterparty owes this instance before further balance additions are rejected
    // e.g. settlements and forwarding of PREPARE packets with debits that increase balance above maximum would be rejected
    maximum?: BigNumber.Value
    // New balance after settlement is triggered
    // Since the balance will never exceed this following a settlement, it's almost a "max balance for settlements"
    settleTo?: BigNumber.Value
    // Automatic settlement is triggered when balance goes below this threshold
    // If undefined, no automated settlement occurs
    settleThreshold?: BigNumber.Value
    // Maximum this instance owes the counterparty before further balance subtractions are rejected
    // e.g. incoming money/claims and forwarding of FULFILL packets with credits that reduce balance below minimum would be rejected
    minimum?: BigNumber.Value
  }
}

export default class LightningPlugin extends EventEmitter2
  implements PluginInstance {
  static readonly version = 2
  readonly _lightning: LndService
  readonly _serviceIsInternal: boolean
  readonly _log: Logger
  readonly _store: Store
  readonly _maxPacketAmount: BigNumber
  readonly _balance: {
    minimum: BigNumber
    maximum: BigNumber
    settleTo: BigNumber
    settleThreshold: BigNumber
  }
  readonly _accounts = new Map<string, LightningAccount>() // accountName -> account
  readonly _plugin: LightningServerPlugin | LightningClientPlugin
  _dataHandler: DataHandler = defaultDataHandler
  _moneyHandler: MoneyHandler = defaultMoneyHandler
  /** Bidirectional streaming RPC to send outgoing payments and receive attestations */
  _paymentStream: PaymentStream
  /** Streaming RPC of newly added or settled invoices */
  _invoiceStream: InvoiceStream

  constructor(
    {
      role = 'client',
      lnd,
      maxPacketAmount = Infinity,
      balance: {
        maximum = Infinity,
        settleTo = 0,
        settleThreshold = -Infinity,
        minimum = -Infinity
      } = {},
      ...opts
    }: LightningPluginOpts,
    { log, store = new MemoryStore() }: PluginServices = {}
  ) {
    super()

    /*
     * Allow consumers to both inject the LND connection
     * externally or pass in the credentials, and the plugin
     * will create it for them.
     */
    const isLndOpts = (o: any): o is LndOpts =>
      (typeof o.tlsCert === 'string' || Buffer.isBuffer(o.tlsCert)) &&
      (typeof o.macaroon === 'string' || Buffer.isBuffer(o.macaroon)) &&
      typeof o.hostname === 'string'
    this._serviceIsInternal = isLndOpts(lnd)
    this._lightning = isLndOpts(lnd) ? connectLnd(lnd) : lnd

    /*
     * Create only a single HTTP/2 stream per-plugin for
     * invoices and payments (not per-account)
     */
    this._paymentStream = createPaymentStream(this._lightning)
    this._invoiceStream = createInvoiceStream(this._lightning)

    this._store = store

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
      this._log.debug(
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

    const loadAccount = (accountName: string) => this.loadAccount(accountName)
    const getAccount = (accountName: string) => {
      const account = this._accounts.get(accountName)
      if (!account) {
        throw new Error(`Account ${accountName} is not yet loaded`)
      }

      return account
    }

    this._plugin =
      role === 'server'
        ? new LightningServerPlugin(
            { getAccount, loadAccount, ...opts },
            { store, log }
          )
        : new LightningClientPlugin(
            { getAccount, loadAccount, ...opts },
            { store, log }
          )

    this._plugin.on('connect', () => this.emitAsync('connect'))
    this._plugin.on('disconnect', () => this.emitAsync('disconnect'))
    this._plugin.on('error', e => this.emitAsync('error', e))
  }

  async loadAccount(accountName: string): Promise<LightningAccount> {
    /** Create a stream from the value in the store */
    const loadValue = async (key: string) => {
      const storeKey = `${accountName}:${key}`
      const subject = new BehaviorSubject(
        new BigNumber((await this._store.get(storeKey)) || 0)
      )

      // Automatically persist it to the store
      subject.subscribe(value => this._store.put(storeKey, value.toString()))

      return subject
    }

    const balance$ = await loadValue('balance')
    const payoutAmount$ = await loadValue('payoutAmount')

    // Account data must always be loaded from store before it's in the map
    if (!this._accounts.has(accountName)) {
      const account = new LightningAccount({
        sendMessage: (message: BtpPacket) =>
          this._plugin._sendMessage(accountName, message),
        dataHandler: (data: Buffer) => this._dataHandler(data),
        moneyHandler: (amount: string) => this._moneyHandler(amount),
        accountName,
        balance$,
        payoutAmount$,
        master: this
      })

      // Since this account didn't previosuly exist, save it in the store
      this._accounts.set(accountName, account)
    }

    return this._accounts.get(accountName)!
  }

  async connect() {
    await waitForReady(this._lightning)
    return this._plugin.connect()
  }

  async disconnect() {
    await this._plugin.disconnect()
    this._accounts.clear()
    /**
     * Only disconnect if the service was created by the plugin.
     * If it was injected, don't automatically disconnect.
     */
    if (this._serviceIsInternal) {
      this._lightning.close()
    }
  }

  isConnected() {
    return this._plugin.isConnected()
  }

  async sendData(data: Buffer) {
    return this._plugin.sendData(data)
  }

  async sendMoney() {
    this._log.error(
      `sendMoney is not supported: use plugin balance configuration`
    )
  }

  registerDataHandler(dataHandler: DataHandler) {
    if (this._dataHandler !== defaultDataHandler) {
      throw new Error('request handler already registered')
    }

    this._dataHandler = dataHandler
    return this._plugin.registerDataHandler(dataHandler)
  }

  deregisterDataHandler() {
    this._dataHandler = defaultDataHandler
    return this._plugin.deregisterDataHandler()
  }

  registerMoneyHandler(moneyHandler: MoneyHandler) {
    if (this._moneyHandler !== defaultMoneyHandler) {
      throw new Error('money handler already registered')
    }

    this._moneyHandler = moneyHandler
    return this._plugin.registerMoneyHandler(moneyHandler)
  }

  deregisterMoneyHandler() {
    this._moneyHandler = defaultMoneyHandler
    return this._plugin.deregisterMoneyHandler()
  }
}
