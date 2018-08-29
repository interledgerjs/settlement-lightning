import { EventEmitter2 } from 'eventemitter2'
import BigNumber from 'bignumber.js'

interface LndPluginOpts { 
	// determines type of plugin
	role: 'client' | 'server'
	// BTC public key
	address: string
	_store?: any
	// max amount permitted in packet
	maxPacketAmount?: BigNumber.Value
	// positive balance = satoshis counterparty owes this plugin
	// negative balance = satoshis this plugin owes the counterparty
	balance?: {
		// max credit willing to extend
		minimum?: BigNumber.Value
		// max mount of credit to accept
		maximum?: BigNumber.Value
		// satoshis to settle to 
		settleTo?: BigNumber.Value
		// settlement is triggered below this amoutn of satoshis
		settleThreshold?: BigNumber.Value
	}
}

class LndPlugin extends EventEmitter2 { 

}
