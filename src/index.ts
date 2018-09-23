import BigNumber from 'bignumber.js'
import { EventEmitter2 } from 'eventemitter2'
import { DataHandler, MoneyHandler, PluginInstance, Logger } from './utils/types'
import createLogger = require('ilp-logger')
import * as debug from 'debug'
import * as IlpPacket from 'ilp-packet'
const BtpPacket = require('btp-packet')
import BtpPlugin, { BtpPacket, BtpSubProtocol } from 'ilp-plugin-btp'
import MiniAccountsPlugin from 'ilp-plugin-mini-accounts'
import LndAccount, { requestId, convert, Unit } from './account'
import StoreWrapper from './utils/store-wrapper'

interface LndPluginOpts {
  role: 'client' | 'server'
  balance ? : {
    minimum ? : BigNumber.Value
    maximum ? : BigNumber.Value
    settleTo ? : BigNumber.Value
    settleThreshold ? : BigNumber.Value
  }
  _store ? : any
  _log ? : Logger
  // This version only implements Lightning, not BTC directly
  lndIdentityPubkey: string
  // 'host:port' that is listening for P2P lightning connections
  lndPeeringHost: string
  // max satoshis permitted in each packet
  maxPacketAmount?: BigNumber.Value
}

/* Master class that creates a sub-plugin using _role.  This
 * is largely used to maintain necessary state while passing the 
 * functionality off to the client and server implementations to
 * handle */
class LndPlugin extends EventEmitter2 implements PluginInstance {

  readonly _store: any
  readonly _log: Logger
  readonly _maxPacketAmount: BigNumber
  readonly _lndIdentityPubkey: string
  readonly _lndPeeringHost: string
	readonly _role: 'client' | 'server'
  private readonly _plugin: LndServerPlugin | LndClientPlugin
  _channels: Map<string, string> // ChannelId -> accountName
  readonly _balance: {
    minimum: BigNumber
    maximum: BigNumber
    settleTo: BigNumber
    settleThreshold ? : BigNumber
  }

  constructor({
    role = 'client',
    lndIdentityPubkey,
    lndPeeringHost,
    maxPacketAmount = Infinity,
    balance: {
      minimum = -Infinity,
      maximum = Infinity,
      settleTo = 0,
      settleThreshold = undefined
    } = {}, ...opts 
  }: LndPluginOpts) {
    super()
    if (typeof lndIdentityPubkey !== 'string') throw new Error(`Lightning identity pubkey required`)
    if (typeof lndPeeringHost !== 'string') throw new Error(`Lightning peering host required`)

    this._role = role
    this._store = new StoreWrapper(opts._store)
		this._channels = new Map()
    this._maxPacketAmount = new BigNumber(maxPacketAmount).abs().dp(0, BigNumber.ROUND_DOWN)
    // logging tools
    this._log = opts._log || createLogger(`ilp-plugin-lnd-${this._role}`)
    this._log.trace = this._log.trace || debug(`ilp-plugin-lnd-${this._role}:trace`)
    // lightning peering credentials
    this._lndIdentityPubkey = lndIdentityPubkey
    this._lndPeeringHost = lndPeeringHost

    // create server or client plugin
    const InternalPlugin = this._role === 'client' ? LndClientPlugin : LndServerPlugin
    this._plugin = new InternalPlugin({
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
        throw new Error('Invalid balance configuration: maximum balance must be greater than or equal to settleTo')
      }
      if (!this._balance.settleTo.gte(this._balance.settleThreshold)) {
        throw new Error('Invalid balance configuration: settleTo mustbe greater than or equal to settleThreshold')
      }
      if (!this._balance.settleThreshold.gte(this._balance.minimum)) {
        throw new Error('Invalid balance configuration: must be greater than or equal to minimum balance')
      }
    } else {
      if (!this._balance.maximum.gt(this._balance.minimum)) {
        throw new Error('Invalid balance configuration: maximum balance must be greater than or equal to minimum balance')
      }
    }
      
    this._plugin.on('connect', () => this.emitAsync('connect'))
    this._plugin.on('disconnect', () => this.emitAsync('disconnect'))
    this._plugin.on('error', e => this.emitAsync('error', e))
  }

  async connect() {
    return this._plugin.connect()
  }

  async disconnect() {
    await this._store.close()
    return this._plugin.disconnect()
  }

  isConnected() {
    return this._plugin.isConnected()
  }

  async sendData(data: Buffer) {
    return this._plugin.sendData(data)
  }

  async sendMoney(amount: string) {
    this._log.error('sendMoney is not supported: use plugin balance configuration instead of connector balance for settlement')
  }

  registerDataHandler(dataHandler: DataHandler) {
    return this._plugin.registerDataHandler(dataHandler)
  }

  deregisterDataHandler() {
    return this._plugin.deregisterDataHandler()
  }

  registerMoneyHandler(moneyHandler: MoneyHandler) {
    return this._plugin.registerMoneyHandler(moneyHandler)
  }

  deregisterMoneyHandler() {
    return this._plugin.deregisterMoneyHandler()
  }
}

/* Treats the plugin as having a single account.  The main distinction
 * between client and server is that client maintains a single account 
 * while servers must store multiple accounts for each of the peers
 * they are communicating with */
class LndClientPlugin extends BtpPlugin implements PluginInstance {

  private _account: LndAccount

  constructor(opts: any) {
    super(opts)
    this._account = new LndAccount({
      master: opts.master,
      accountName: 'server',
      sendMessage: (message: BtpPacket) => this._call('', message)
    })
  }

  /** Ilp-plugin-btp calls _connect at the end of it's connect function
   * intending plugins to overwrite it.  Once a client calls _connect
   * it will send it's necessary auth info / plugin specific details
   * to the server which will take that plugin specific information
   * in it's _connect function and configure the relationship needed
   * to exist at the first (blockchain) or second (payment channel) layer
   * in order to maintain the relationship that is used to transfer
   * value outside the domain of BTP.
   *
   * The .connect BTP relationship is managed between
   * ilp-plugin-btp and ilp-plugin-mini-accounts while
   * the ._connect plugin specific relationship is left 
   * unimplemented in those abstract plugins so that the concrete
   * plugins like BTC, ETH, XRP, .. are able to establish a relationship
   * specific to the demands of their protocols.
   */
  async _connect(): Promise < void > {
    // sets up peer account & exchanges lnd identity pubkeys
    await this._account.connect()
  }

  _handleData(from: string, message: BtpPacket): Promise < BtpSubProtocol[] > {
    return this._account.handleData(message, this._dataHandler)
  }

  _handleMoney(from: string, message: BtpPacket): Promise < BtpSubProtocol[] > {
    return this._account.handleMoney(message, this._moneyHandler)
  }

  async sendData(buffer: Buffer): Promise < Buffer > {
    const preparePacket = IlpPacket.deserializeIlpPacket(buffer)
    const response = await this._call('', {
      type: BtpPacket.TYPE_MESSAGE,
      requestId: await requestId(),
      data: {
        protocolData: [{
          protocolName: 'ilp',
          contentType: BtpPacket.MIME_APPLICATION_OCTET_STREAM,
          data: buffer
        }]
      }
    })
    const ilpResponse = response.protocolData.filter((p: any) => p.protocolName === 'ilp')[0]
    if (ilpResponse) {
      const responsePacket = IlpPacket.deserializeIlpPacket(ilpResponse.data)
      this._account.handlePrepareResponse(preparePacket, responsePacket)
      return ilpResponse.data
    }
    return Buffer.alloc(0)
  }

  _disconnect(): Promise < void > {
    return this._account.disconnect()
  }
}

/* Main difference between server and client is that plugin 
 * manages multiple accounts.  After that, most of the functionality
 * is the same and is taken care of in src/account.ts */
class LndServerPlugin extends MiniAccountsPlugin implements PluginInstance {

  private _accounts: Map < string, LndAccount >
  private _master: LndPlugin

  constructor(opts: any) {
    super(opts)
    this._master = opts.master
    this._accounts = new Map()
  }

  /* Gets the corresponding account for whichever peer we 
   * wish to communicate with.  Client does not have this because
   * it only manages one account */
  _getAccount(address: string) {
    const accountName = this.ilpAddressToAccount(address)
    let account = this._accounts.get(accountName)

    if (!account) {
      account = new LndAccount({
        accountName,
        master: this._master,
        sendMessage: (message: BtpPacket) => this._call(address, message)
      })
      this._accounts.set(accountName, account)
    }
    return account
  }

  _connect(address: string, message: BtpPacket): Promise < void > {
    return this._getAccount(address).connect()
  }
		
  _handleCustomData = async(from: string, message: BtpPacket): Promise < BtpSubProtocol[] > =>
    this._getAccount(from).handleData(message, this._dataHandler)

  _handleMoney(from: string, message: BtpPacket): Promise < BtpSubProtocol[] > {
    return this._getAccount(from).handleMoney(message, this._moneyHandler)
  }

  _handlePrepareResponse = async(
      destination: string,
      responsePacket: IlpPacket.IlpPacket,
      preparePacket: IlpPacket.IlpPacket
    ): Promise < void > =>
    this._getAccount(destination).handlePrepareResponse(preparePacket, responsePacket)

  _close(from: string): Promise < void > {
    return this._getAccount(from).disconnect()
  }
}

export = LndPlugin
