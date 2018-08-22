'use strict'

//see https://api.lightning.community/
//https://github.com/lightningnetwork/lnd/blob/master/docs/grpc/javascript.md#setup-and-installation

const grpc = require('grpc');
const protoLoader = require('@grpc/proto-loader');
const fs = require('fs');
const path = require('path');
const byteBuffer = require('bytebuffer');

process.env.GRPC_SSL_CIPHER_SUITES = 'HIGH+ECDSA';

class Lightning{

	constructor(certPath,lndPath,protoPath,macaroonPath){
		this.certPath = certPath || null;
		this.macaroonPath = macaroonPath || null;
		this.lndPath = lndPath ||  'localhost:10009';
		this.protoPath = protoPath || path.join(__dirname,'rpc.proto');

		this.addressType = {
	    	p2wkh: 'p2wkh',
	    	np2wkh: 'np2wkh'
	    }
	}

	_getCertPath () {
		return new Promise((resolve,reject) => {
			if(this.certPath){
				resolve(this.certPath);
			}
			else{
				//check linux
				this.certPath = `${process.env.HOME}/.lnd/tls.cert`;
				fs.stat(this.certPath,(err,ret)=>{
					if(ret){
						this.certPath = `${process.env.HOME}/.lnd/tls.cert`;
						resolve(this.certPath);
					}
					else{
						this.certPath = `${process.env.HOME}/Library/Application Support/Lnd/tls.cert`;
						fs.stat(this.certPath,(err,ret)=>{
							if(err) throw err
							resolve(`${process.env.HOME}/Library/Application Support/Lnd/tls.cert`);
						})
					}
				});
			}
		});
	}

	_getCertificate (certPath) {
		return new Promise((resolve,reject)=>{
			fs.readFile(certPath,(err,cert)=>{
				if(err) throw err;
				resolve(cert);
			});
		});
	}

	_loadLndDescriptor () {
		return new Promise((resolve,reject)=>{
			let opts = {keepCase: true, longs: String, enums: String, defaults: true, oneofs: true};
			protoLoader.load(this.protoPath,opts).then((packageDefinition)=>{
				let lnrpcDescriptor = grpc.loadPackageDefinition(packageDefinition);
				let lnrpc = lnrpcDescriptor.lnrpc;
				resolve(lnrpc);
			}).catch((err)=>{
				throw err;
			});
			
		});
	}

	_getMacaroonPath () {
		return new Promise((resolve,reject) => {
			if(this.macaroonPath){
				resolve(this.macaroonPath);
			}
			else{
				//check linux
				this.macaroonPath = `${process.env.HOME}/.lnd/admin.macaroon`;
				fs.stat(this.macaroonPath,(err,ret)=>{
					if(ret){
						resolve(this.macaroonPath);
					}
					else{
						this.macaroonPath = `${process.env.HOME}/Library/Application Support/Lnd/admin.macaroon`;
						fs.stat(this.macaroonPath,(err,ret)=>{
							if(err) throw err
							resolve(this.macaroonPath);
						})
					}
				});
			}
		});
	}

	_getMacaroonMeta (macaroonPath) {
		macaroonPath = macaroonPath || this.macaroonPath;
		return new Promise((resolve,reject)=>{
			fs.readFile(macaroonPath,(err,ret)=>{
				if(err) throw err;
				let macaroon = ret.toString('hex');
				let meta = new grpc.Metadata()
				meta.add('macaroon', macaroon);
				resolve(meta);
			});		
		});
	}

	_getMacaroonCreds (meta) {
		return new Promise((resolve,reject)=>{
			let macaroonCreds = grpc.credentials.createFromMetadataGenerator((_args, callback) => {
	  			callback(null, meta);
			});
			resolve(macaroonCreds);
		})
	}

	async initialize(){
		try{
			let certPath = await this._getCertPath();
			let lndCert = await this._getCertificate(certPath);
			let lnrpc = await this._loadLndDescriptor();
			
			let macaroonPath = await this._getMacaroonPath();
			let macaroonMeta = await this._getMacaroonMeta(macaroonPath);
			let macaroonCreds = await this._getMacaroonCreds(macaroonMeta);

			
			let sslCreds = grpc.credentials.createSsl(lndCert);
			let credentials = grpc.credentials.combineChannelCredentials(sslCreds, macaroonCreds);

			this.lightning = new lnrpc.Lightning(this.lndPath, credentials);
			this.initialized = true;
			return true;
		}
		catch(e){
			throw e;
		}	
	}

	checkInitialized() {
		return new Promise((resolve,reject)=>{
			if(this.initilized){
				this.initialize().then((initialzed)=>{
					resolve(true);
				}).catch((e) => {
					throw e;
				})
			}
			else{
				resolve(true);
			}		
		});
	}

	async callSimple(func, options){
		try{
			await this.checkInitialized();
			let result = await new Promise((resolve, reject) => {
				this.lightning[func](options, (err, ret)=> {
					if(err) return reject(err);
			  		resolve(ret);
			  	});
			});
			return result;
		}
		catch(e){
			throw e;
		}
	}

	async callStream(func, options, statusCallback){
		try{
			await this.checkInitialized();
			let result = await new Promise((resolve, reject) => {
				var call = this.lightning[func](options);
				let result = null;
				call.on('data', (data) => {
					result = data;
					if(statusCallback){
						statusCallback(null,data)
					}
				}).on('end', () => {
					resolve(result);
				})
			});
			return result;
		}
		catch(e){
			if(statusCallback){
				statusCallback(e,null);
			}
			throw e;
		}
	}

	async getInfo(){
		try{
			let result = await this.callSimple('GetInfo',{});
			return result;
		}
		catch(e){
			throw e;
		}
	}

	async walletBalance () {
    	try{
			let result = await this.callSimple('walletBalance',{});
			return result;
		}
		catch(e){
			throw e;
		}
    }

	async newAddress (addressType) {
    	try{
			let result = await this.callSimple('newAddress',{addressType: addressType});
			return result;		
		}
		catch(e){
			throw e;
		}
    }

	async connect ({addr=null, pubkey=null, host=null, perm=false}) {
    	if(addr){
    		let ar = addr.split('@');
    		pubkey = ar[0];
    		host = ar[1];
    	}
    	let opts = {};
    	opts.addr = {pubkey: pubkey, host: host	};
    	
    	if(perm) opts.perm = perm;
    	console.log(opts);
    	try{
			let result = await this.callSimple('connectPeer',opts);
			return result;
		}
		catch(e){
			throw e;
		}
    }

    async listPeers () {
    	try{
			let result = await this.callSimple('listPeers',{});
			return result;
		}
		catch(e){
			throw e;
		}
    }

    //need to do some work on formatting the output
	async openChannel (
		{
			node_pubkey = null,
			local_funding_amount = 0,
			push_sat = -1,
			target_conf = -1,
			sat_per_byte = -1,
			_private = false,
			min_htlc_msat = -1,
			remote_csv_delay = -1
		},
		statusCallback
	){
	
		let  node_pubkey_string = '';
		let opts = {};
		
		if(node_pubkey && typeof(node_pubkey)==='string'){
			opts.node_pubkey = Buffer.from(node_pubkey,'hex');
		}
		else{
			opts.node_pubkey = node_pubkey;

		}
	
		if(local_funding_amount>0) opts.local_funding_amount = local_funding_amount;
		if(push_sat>0) opts.push_sat = push_sat;
		if(target_conf>0) opts.target_conf = target_conf;
		if(sat_per_byte>0) opts.sat_per_byte = sat_per_byte;
		if(_private) opts.private = _private;
		if(min_htlc_msat>0) opts.min_htlc_msat = min_htlc_msat;
		if(remote_csv_delay>0) opts.remote_csv_delay = remote_csv_delay;

		try{
			let result = await this.callStream('openChannel',opts,statusCallback);
			return result.chan_open;
		}
		catch(e){
			throw e;
		}
	}

	async channelBalance () {
		try{
			let result = await this.callSimple('channelBalance',{});
			return result;		
		}
		catch(e){
			throw e;
		}
	} 

	//adding options didn't work so leaving out for now
	async listChannels (){
		let opts = {};
		
		try{
			let result = await this.callSimple('listChannels',opts);
			return result;
		}
		catch(e){
			throw e;
		}
	}

	async pendingChannels () {
		try{
			let result = await this.callSimple('pendingChannels',{});
			return result;
		}
		catch(e){
			throw e;
		}
	}	

	//keeping this simple for now - just accepting amt 
 	async addInvoice ({amt = 0}) {
 		let opts = {value: amt};
		try{
			let result = await this.callSimple('addInvoice',opts);
			return result;
		}
		catch(e){
			throw e;
		}
	}

	async decodePayReq ({pay_req}) {
    	try{
			let result = await this.callSimple('decodePayReq',{pay_req});
			return result;
		}
		catch(e){
			throw e;
		}
    }

	/*
	//asks for a payment hash
	bidirectionalStreamsendPayment ({dest, amt}){
		return new Promise((resolve, reject) => {
			try{
				let destBytes =  byteBuffer.fromHex(dest);
				let call = this.lightning.sendPayment();
				let result = null;
				call.on('data', function(payment) {
					console.log(payment);
				  	result = payment;
				});
				call.on('end', function() {
					console.log('done');
					resolve(result);
				});
				call.write({ amt: amt, dest_string: dest});
			}
			catch(e){
				reject(e);
			}
		});
	}
	*/
	
	async sendPayment ({pay_req = null}) { //, dest = null, amt = 0
		
		//if(pay_req){
			let opts = {payment_request: pay_req};		
			
			try{
				let result = await this.callSimple('sendPaymentSync',opts);
				return result;
			}
			catch(e){
				throw e;
			}
		//}
		/*
		else{
			try{
				await this.checkInitialized();
				let result = await this.bidirectionalStreamsendPayment({dest,amt})
				return result;
			}
			catch(e){
				throw e;
			}
		}
		*/
	}

	async getChanInfo ({chan_id}) {
		try{
			let result = await this.callSimple('getChanInfo',{chan_id: chan_id});
			return result;
		}
		catch(e){
			throw e;
		}
	}

	formatChannelPoint (channelPoint) {
		var ar = channelPoint.split(':');
		return {
			funding_txid_str: ar[0],
			output_index: ar[1]
		}
	}

	async closeChannel({chan_id = null, channel_point = null, force = false, target_conf = 0, sat_per_byte = 0}, statusCallback) {
		let opts = {};
		if(channel_point) opts.channel_point = channel_point;
		if(force) opts.force = force;
		if(target_conf) opts.target_conf = target_conf;
		if(sat_per_byte) opts.sat_per_byte = sat_per_byte;
		try{
			if(chan_id && !opts.channel_point){
				let channelInfo = await this.getChanInfo({chan_id: chan_id});
				opts.channel_point = channelInfo.chan_point;
			}
			opts.channel_point = this.formatChannelPoint(opts.channel_point);
			console.log(opts);
			let result = await this.callStream('closeChannel',opts,statusCallback);
			return result;
		}
		catch(e){
			throw e;
		}
	}

  	async disconnect ({pub_key=null}) {
  		
    	let opts = {pub_key: pub_key};
    	try{

    		let result = await this.callSimple('disconnectPeer',opts);
    		return result;
   			
		}
		catch(e){
			throw e;
		}
    }




	
}

module.exports = {
	lightning: Lightning
}