'use strict'


class Account {
  	constructor (accountName, ilpAddress) {
  		this._accountName = accountName;
  		this._ilpAddress = ilpAddress;
  	}

  	get name () {
  		return this._accountName;
  	}

  	get ilpAddress () {
  		return this._ilpAddress
 	}

  	set lightningAddress (address){
  		this._lightningAddress = address;
  	}

  	get lightningAddress () {
  		return this._lightningAddress || null;
  	}

    get lightningPubKey () {
      if(!this._lightningAddress) return null;
      return this._lightningAddress.split('@')[0];
    }

  	set channelId (channelId){
  		this._channelId = channelId;
  	}

  	get channelId () {
		return this._channelId || null;
	}

	set balance (channelId){
		this._channelId = channelId;
	}

	get balance () {
	  return this._channelId || null;
  }
	  

}

module.exports = Account