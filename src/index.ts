import BigNumber from 'bignumber.js'
import { EventEmitter2 } from 'eventemitter2'
import { DataHandler, MoneyHandler } from './utils/types'
import { Logger, PluginInstance } from './types'
import createLogger = require('ilp-logger')
import * as debug from 'debug'
import * as IlpPacket from 'ilp-packet'
import BtpPlugin, { BtpPacket, BtpSubProtocol } from 'ilp-plugin-btp'
import MiniAccountsPlugin from 'ilp-plugin-mini-accounts'
import LndAccount, { requestId, convert, Unit } from './account'
const BtpPacket = require('btp-packet')
import StoreWrapper from './utils/store-wrapper'

interface LndPluginOpts {
  _role: 'client' | 'server'
  _balance ? : {
    minimum ? : BigNumber.Value
    maximum ? : BigNumber.Value
    settleTo ? : BigNumber.Value
    settleThreshold ? : BigNumber.Value
  }
  _store ? : any
  _log ? : Logger
  /* We are working exclusively with lightning identity
   * public keys currently.  Further updates will add in functionality
   * for direct BTC public keys */
  _lndIdentityPubkey: string
  /* 'host:port' that is listening for P2P lightning connections */
  _lndPeeringHost: string
  // max satoshis permitted in each packet
  maxPacketAmount?: BigNumber.Value
}

/* Master class that creates a sub-plugin using _role.  This
 * is largely used to maintain necessary state while passing the 
 * functionality off to the client and server implementations to
 * handle */
class LndPlugin extends EventEmitter2 implements LndPluginOpts {
  
  // denominated in Satoshis
  readonly _balance: {
    minimum: BigNumber
    maximum: BigNumber
    settleTo: BigNumber
    settleThreshold ? : BigNumber
  }

  readonly _store: any
  readonly _log: Logger
  readonly _lndIdentityPubkey: string
  readonly _lndPeeringHost: string
  // TODO implement peer as _role
  // FIXME Should this be private?
	readonly _role: 'client' | 'server'
  private readonly _plugin: LndServerPlugin | LndClientPlugin
  _channels: Map<string, string> // ChannelId -> accountName
  readonly _maxPacketAmount: BigNumber

  constructor(opts: LndPluginOpts) {
    super()

    this._maxPacketAmount = new BigNumber(opts.maxPacketAmount || Infinity)
      .abs().dp(0, BigNumber.ROUND_DOWN)

    this._balance = {
      minimum: new BigNumber((opts._balance && opts._balance.minimum) || Infinity)
        .dp(0, BigNumber.ROUND_FLOOR),
      maximum: new BigNumber((opts._balance && opts._balance.maximum) || Infinity)
        .dp(0, BigNumber.ROUND_FLOOR),
      settleTo: new BigNumber((opts._balance && opts._balance.settleTo) || Infinity)
        .dp(0, BigNumber.ROUND_FLOOR),
      settleThreshold: new BigNumber((opts._balance && opts._balance.settleThreshold) || Infinity)
        .dp(0, BigNumber.ROUND_FLOOR)
    }

    // default to client 
    this._role = opts._role || 'client'

    // create server or client plugin
    const InternalPlugin = this._role === 'client' ? LndClientPlugin : LndServerPlugin
    this._plugin = new InternalPlugin({
			...opts,
			master: this
    })

    // Used for communication over lightning
    this._lndIdentityPubkey = opts._lndIdentityPubkey
    this._lndPeeringHost = opts._lndPeeringHost

    // logging tools
    this._log = opts._log || createLogger(`ilp-plugin-lnd-${this._role}`)
    this._log.trace = this._log.trace || debug(`ilp-plugin-lnd-${this._role}:trace`)

		this._channels = new Map()

    this._store = new StoreWrapper(opts._store)
  }

  async connect() {
    return this._plugin.connect()
  }

  async disconnect() {
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
    this._account.beforeForward(preparePacket)

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
    const responsePacket = IlpPacket.deserializeIlpPacket(ilpResponse.data)

    await this._account.afterForwardResponse(preparePacket, responsePacket)

    return ilpResponse ? ilpResponse.data : Buffer.alloc(0)
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

  /** In Mini-Accounts _connect is called once the server receives an
   * incoming websocket connection.  It then verifies auth and calls
   * _connect with the intent for it to be overwritten at the plugin 
   * level where it passes along the IlpAddress that is needed for%
   * address: IlpAddress
   * message: authPacket that mini-accounts passes to this function,
   * but I don't believe we need to use it here */
  _connect(address: string, message: BtpPacket): Promise < void > {
    return this._getAccount(address).connect()
  }
		
  _handleCustomData = async(from: string, message: BtpPacket): Promise < BtpSubProtocol[] > =>
    this._getAccount(from).handleData(message, this._dataHandler)

  _handleMoney(from: string, message: BtpPacket): Promise < BtpSubProtocol[] > {
    return this._getAccount(from).handleMoney(message, this._moneyHandler)
  }

  _sendPrepare(destination: string, preparePacket: IlpPacket.IlpPacket) {
    // Currently causing an error when Stream sends ILDCP request 
  }

  _handlePrepareResponse = async(
      destination: string,
      responsePacket: IlpPacket.IlpPacket,
      preparePacket: IlpPacket.IlpPacket
    ): Promise < void > =>
    this._getAccount(destination).afterForwardResponse(preparePacket, responsePacket)

  _close(from: string): Promise < void > {
    return this._getAccount(from).disconnect()
  }
}

export = LndPlugin
