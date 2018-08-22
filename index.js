const PluginMiniAccounts = require('ilp-plugin-mini-accounts');
const BtpPacket = require('btp-packet');
const Store = require('./src/store');
const Account = require('./src/account');
const { InvalidFieldsError, NotAcceptedError } = require('./src/errors');
const protocolDataParser = require('./src/protocol_data_parser');
const accounts = new Store();
const LndLib = require('./src/lndlib');
const crypto = require('crypto');
const {  util, ChannelWatcher } = require('ilp-plugin-xrp-paychan-shared');
const debug = require('debug')('server');

const GET_INVOICE = 'get_invoice';
const PAYMENT_PREIMAGE = 'payment_preimage';

let sha256 = (data) => crypto.createHash('sha256').update(data).digest().toString('hex');

class Plugin extends PluginMiniAccounts {
	
	constructor (opts){
		console.log(opts);
		if (!opts.maxInFlight && !opts.maxUnsecured) {
			//    throw new InvalidFieldsError('missing opts.maxInFlight');
		}
		else if(!opts.externalIP){
			throw new InvalidFieldsError('missing opts.externalIP');
		}

		super(opts);

		this.maxBalance = opts.maxBalance || 10000000; 
		this.maxUnsecured = opts.maxUnsecured || opts.maxInFlight;
		this.authToken = opts.authToken;
		this._externalIP = opts.externalIP;

		this._setupLnChannel = opts._setupLnChannel || true; //default to setting up a channel
		this._channelLocalFunding = opts._channelLocalFunding || 1000000;
		this._protocolCallFunctions = {};
		this._protocolCallFunctions['channel_info'] = this._processChannelInfo.bind(this);
		this._protocolCallFunctions['get_lightning_info'] = this._getLightningInfo.bind(this);
		this._protocolCallFunctions[GET_INVOICE] = this._getInvoice.bind(this);
			
		debug('setting up lightning');
		this._lightning = new LndLib.lightning(opts._lndCertPath,opts._lndHost,opts._lndProtoPath,opts._lndMacaroonPath);
		this._lightning.initialize().then(()=>{
			debug('lightning initialized');
		});
		this._invoices = new Map();
	}

	async _connect (address, { requestId, data }) {
		debug('server connected');
		try{
			if(!this._lightningAddress){
				debug('getting lightning info');
				let lightningInfo = await this._lightning.getInfo();
				debug('got lightning info');
				this._lightningAddress = `${lightningInfo.identity_pubkey}@${this._externalIP}`;
			}			
			return null;
		}
		catch(e){
			debug(e);
			throw e;
		}
	}

	async _getAccount (from) {
		let accountName = this.ilpAddressToAccount(from);
		let account = await accounts.get(accountName);

		if (!account) {
			account = new Account(accountName,from);
			await accounts.put(accountName, account);
		}
		return account;
	}

	async _connectToPeer (account){
		let ret = await this._lightning.listPeers();
		debug(ret.peers);
		if(ret.peers.length===0){
			debug('no peers exist - connecting to peer');
			await this._lightning.connect({addr: account.lightningAddress});
			debug('connected to peer');
		}
		return;
	}

	async _getExistingChannel (account) {
		if(account.channelId){
			try{
				let info = await this._lightning.getChanInfo({chan_id: account.channelId});
				debug(info);
				return info;
			}
			catch(e){
				account.channelId = null;
				return await this._getExistingChannel(account);
			}
		}
		else{
			try{
				let channel = await this._getChannel(account.lightningPubKey);
				if(channel && channel.local_balance>0){
					return channel;
				}
				else{
					return null;
				}
			}
			catch(e){
				throw e;
			}
		}
	}

	async _getChannelId (pub_key) {
		let channel = await this._getChannel(pub_key);
		if(!channel) return null;
		return channel.chan_id;
	}

	async _getChannel (pub_key) {
		debug('---------------------------');
		let channels = await this._lightning.listChannels();
		debug('pub key: ' + pub_key);
		debug(channels);
		
		let filter = channels.channels.filter(c=>(c.remote_pubkey===pub_key && c.local_balance>0));
		if(filter.length===0){
			return null;
		}
		else{
			return filter[0];
		}
	}

	async _setupChannel (account) {
		debug('setting up channel');
		await this._connectToPeer (account);
		if(!this._setupLnChannel) return null;
		
		debug(`setting up channel for ${account.lightningAddress} - server`);
		let existingChannel = await this._getExistingChannel(account);
		if(existingChannel){
			debug('channel already exists');

			account.channelId = existingChannel.chan_id;
			await accounts.put(account.name,account);
			return null;
		}
		
		try{
			let walletBalance = await this._lightning.walletBalance();
			debug(walletBalance);
			let confirmed = parseInt(walletBalance.confirmed_balance);
			if(confirmed<this._channelLocalFunding){
				throw new Error('Insufficient wallet balance to open channel');
				//TODO: need to think through how to handle this
			}
			
			let channel = await this._lightning.openChannel(
				{
					node_pubkey: account.lightningPubKey,
					local_funding_amount: this._channelLocalFunding
				},
				async (err, status) => {
					try{
						if(status && status.chan_pending){
							debug(status);
						}
						else if (status && status.chan_open){
							debug(status);
						}
						else if(err){
							throw err;
						}
					}
					catch(e){
						debug(e);
						//throw e;
					}
				});
	
			debug('channel open');
			debug(channel);
			account.channelId = await this._getChannelId (account.lightningPubKey);
			debug('channel ID:' + account.channelId);
			
			await accounts.put(account.name,account);
			debug(`Channel created. chan_id: ${account.channelId}`);
			
			return null;
			
		}
		catch(e){
			debug(e);
			return null;
			//throw e;
		}
	}

	/******** manage incoming messages  *****************/

	async _processChannelInfo (account,requestId,data) {
		debug('server - called process channel info');
		let account = await this._getAccount(address);
		account.channelId = data.channelId;
		account.balance = data.balance;
		await accounts.put(account.name, account);
		this._setupChannel(account);
		let packet = protocolDataParser.composeJSONPacket('info',{type: 'channel_info'});
		return packet;
		
	}

	async _getLightningInfo (account,requestId,data) {
		debug('server - called send lightning info');
		try{
			if(data.address){
				account.lightningAddress = data.address;
				await accounts.put(account.name,account);
			}

			let packet = protocolDataParser.composeJSONPacket('info',{type: 'lightning_info', address: this._lightningAddress});
			return packet;
			
		}
		catch(e){
			debug(e);
			throw e;
		}
	}

	async _getInvoice (account, requestId, amount) {
		debug('get invoice');
		let invoice = await this._lightning.addInvoice({amt: amount});
		this._invoices.set(invoice.r_hash, amount);
		return [{
			protocolName: GET_INVOICE,
			contentType: BtpPacket.MIME_APPLICATION_JSON,
			data: Buffer.from(JSON.stringify({
				paymentRequest: invoice.payment_request
			}))
		}];
		

		return null;

	}

	/****************************************************/

	

	async _handleData (address, { requestId, data }) {
		debug('got data server');
		let account = await this._getAccount(address);
		let { ilp, protocolMap } = this.protocolDataToIlpAndCustom(data);
		
		debug(protocolMap);
		

		if (protocolMap.ilp && ilp[0] === IlpPacket.Type.TYPE_ILP_PREPARE) {
			/*
			if (response[0] === IlpPacket.Type.TYPE_ILP_REJECT) {
				//this._rejectIncomingTransfer(account, ilp)
			} 
			else if (response[0] === IlpPacket.Type.TYPE_ILP_FULFILL) {
			  // TODO: should await, or no?
				let { amount } = IlpPacket.deserializeIlpPrepare(ilp);
			  	if (amount !== '0' && this._moneyHandler) this._moneyHandler(amount)
			}
			*/
		}
		else if(protocolMap.info && protocolMap.info.type && this._protocolCallFunctions[protocolMap.info.type]){
			debug('here');
			var ret = await this._protocolCallFunctions[protocolMap.info.type](account,requestId,protocolMap.info);
			return [ret];
		}
		else if(protocolMap[GET_INVOICE]){
			return await this._protocolCallFunctions[GET_INVOICE](account,requestId,protocolMap[GET_INVOICE]);
		}
		else{
			if (!this._dataHandler) throw new Error('no request handler registered');
			if(ilp){
				let response = await this._dataHandler(ilp);
				return this.ilpAndCustomToProtocolData({ ilp: response });
			}
			else{
				return null;
			}
		}
			
	}

	async _handleMoney (from, { requestId, data }) {
		const amount = data.amount;
		let protocolData = data.protocolData.filter(p => p.protocolName === 'payment_preimage')[0].data.toString();
		let paymentPreimage = JSON.parse(protocolData).paymentPreimage;
		const condition = sha256(paymentPreimage);
		const invoiceAmount = this._invoices.get(condition);
		if (!invoiceAmount) {
			throw new Error('no invoice found. condition=' + condition);
		}
		if (invoiceAmount !== amount) {
			throw new Error(`settlement amount does not match invoice amount. Invoice=${invoiceAmount} amount=${amount}`);
		}
	  	this.invoices.delete(condition);
	    if (this._moneyHandler) {
			await this._moneyHandler(amount);
		}
	  
		return [];

	}

}

module.exports = Plugin;