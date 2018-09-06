import BigNumber from 'bignumber.js'
import { EventEmitter2 } from 'eventemitter2'
import { DataHandler, MoneyHandler } from './utils/types'
import { Logger, PluginInstance } from './types'
import createLogger = require('ilp-logger')
import * as debug from 'debug'
import * as IlpPacket from 'ilp-packet'
import BtpPlugin, { BtpPacket, BtpSubProtocol } from 'ilp-plugin-btp'
import MiniAccountsPlugin from 'ilp-plugin-mini-accounts'
import BtcAccount, { requestId, convert, Unit } from './account'
const BtpPacket = require('btp-packet')
//import StoreWrapper from './store-wrapper'

interface LndPluginOpts {
	_role: 'client' | 'server'
	_balance?: {
		minimum? : BigNumber.Value
		maximum?: BigNumber.Value
		settleTo?: BigNumber.Value
		settleThreshold?: BigNumber.Value
	}
	_store?: any
	_log?: Logger
	_address: string
}

class BtcPlugin extends EventEmitter2 implements LndPluginOpts {
	//private readonly _plugin: LndClientPlugin | LndServerPlugin
	// denominated in Satoshis
	readonly _balance: { 
		minimum: BigNumber
		maximum: BigNumber
		settleTo: BigNumber
		settleThreshold?: BigNumber
	}
	readonly _store: any
	readonly _log: Logger
	// FIXME Should this be private?
	readonly _role: 'client' | 'server'
	//_channels: Map<string, string> // ChannelId -> accountName
	readonly _address: string

	constructor (opts: LndPluginOpts) { 
		super()
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
		this._role = opts._role || 'client'
		this._log = opts._log || createLogger(`ilp-plugin-lnd-${this._role}`)
		this._log.trace = this._log.trace || debug(`ilp-plugin-lnd-${this._role}:trace`)
		this._address = opts._address

		//this._store = new StoreWrapper(opts._store)
	}

	async connect () {
		this._channels = new Map(await this._store.loadObject('channels'))
		return this._plugin.connect()
	}

	async disconnect () { 
		return this._plugin.disconnect()
	}

	isConnected () {
		return this._plugin.isConnected()
	}

	async sendData (data: Buffer) {
		return this._plugin.sendData(data)
	}

	async sendMoney (amount: string) {
		this._log.error('sendMoney is not supported: use plugin balance configuration instead of connector balance for settlement')
	}

	registerDataHandler (dataHandler: DataHandler) {
		return this._plugin.registerDataHandler(dataHandler)
	}

	deregisterDataHandler () {
		return this._plugin.deregisterDataHandler()
	}

	registerMoneyHandler (moneyHandler: MoneyHandler) {
		return this._plugin.registerMoneyHandler(moneyHandler)
	}

	deregisterMoneyHandler() {
		return this._plugin.deregisterMoneyHandler()
	}
}

class BtcClientPlugin extends BtpPlugin implements PluginInstance {
	private _account: BtcAccount
	private _master: BtcPlugin

	constructor (opts: any) {
		super({
			responseTimeout: 3500000,
			...opts
		})
		this._master = opts.master

		this._account = new BtcAccount({
			master: opts.master,
			accountName: 'server',
			sendMessage: (message: BtpPacket) => this._call('', message)
		})
	}

	async _connect(): Promise<void> {
		await this._account.connect()
		await this._account.shareAddress()
		return this._account.attemptSettle()
	}

	_handleData (from: string, message: BtpPacket): Promise<BtpSubProtocol[]> {
		return this._account.handleMoney(message, this._dataHandler)
	}

	_handleMoney (from: string, message: BtpPacket): Promise<BtpSubProtocol[]> {
		return this._account.handleMoney(message, this._moneyHandler)
	}

	async sendData (buffer: Buffer): Promise<Buffer> {
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

	_disconnect (): Promise<void> {
		return this._account.disconnect()
	}
}

class BtcServerPlugin extends MiniAccountsPlugin implements PluginInstance {
	private _accounts: Map<string, BtcAccount>
	private _master: BtcPlugin
	constructor (opts: any) {
		super(opts)

		this._master = opts.master
		this._accounts = new Map()
	}

	_getAccount (address: string) {
		const accountName = this.ilpAddressToAccount(address)
		let account = this._accounts.get(accountName)

		if (!account) {
			account = new BtcAccount({
				accountName,
				master: this._master,
				sendMessage: (message: BtpPacket) => this._call(address, message)
			})
			this._accounts.set(accountName, account)
		}
		return account
	}

	_connect (address: string, message: BtpPacket): Promise<void> {
		return this._getAccount(address).connect()
	}

	_handleCustomData = async (from: string, message: BtpPacket): Promise<BtpSubProtocol[]> =>
		this._getAccount(from).handleData(message, this._dataHandler)

	_handleMoney (from: string, message: BtpPacket): Promise<BtpSubProtocol[]> {
		return this._getAccount(from).handleMoney(message, this._moneyHandler)
	}


	_sendPrepare (destination: string, preparePacket: IlpPacket.IlpPacket) {
		// Currently causing an error when Stream sends ILDCP request 
	}

	_handlePrepareResponse = async (
		destination: string,
		responsePacket: IlpPacket.IlpPacket,
		preparePacket: IlpPacket.IlpPacket
	): Promise<void> =>
		this._getAccount(destination).afterForwardResponse(preparePacket, responsePacket)

	_close (from: string): Promise<void> {
		return this._getAccount(from).disconnect()
	}

}

export = BtcPlugin
