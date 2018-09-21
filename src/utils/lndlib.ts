const grpc = require('grpc')
const fs = require('fs')
const process = require('process')
const path = require('path')
const protoLoader = require('@grpc/proto-loader')
const promisify = require('util').promisify
import BigNumber from 'bignumber.js'
process.env.GRPC_SSL_CIPHER_SUITES = 'HIGH+ECDSA'

const sleep = require('util').promisify(setTimeout)

export default class LndLib {

  private lightning: any
  private connected: boolean
  constructor() {
    // First request connects to lnd
    this.connected = false
  }

  /******************* Personal information queries *****************/

  /** An important distinction to understand lightning:
   *
   * BTC public key: the public key that is used to
   * directly identify oneself on the Bitcoin blockchain
   *
   * Lnd Identity Pubkey: the public key that is used to
   * identify oneself on the lightning network, one step
   * removed from the direct blockchain.
   *
   * Why is this distinction made? Because lightning was designed
   * with the belief that you wouldn't need a payment channel to
   * every peer you interact with, that the routing protocol they
   * implemented would take care of that through intermediate peers.  
   * Therefore, if you need to send an invoice / receive an 
   * invoice from somebody, all you need to know is their identity
   * pubkey so that you can ping them for invoices without needing
   * to know their underlying BTC blockchain public key.
   */

  async getLndIdentityPubkey(): Promise < string > {
    return (await this.getInfo()).identity_pubkey
  }

	/* retrieve general info about one's own lightning daemon,
   * currently used to retrieve identity_pubkey, will likely be used
   * in future to check for number of peers, active/pending channels, 
   * and other general state */
	async getInfo(): Promise < any > {
		return await this._lndQuery('getInfo', {})
  }

  /******************** Payment functionality ******************/

  /** Creates an invoice for the amount requested.  Returns
   * the payment_request which will be sent to the person
   * desiring to pay so that they can complete the payment 
   */
  async addInvoice(amt: number) : Promise < string > {
    return await this._lndQuery('addInvoice', { value : amt })
  }

  async decodePayReq(payment_request : string) : Promise < any > {
    return await this._lndQuery('decodePayReq', { pay_req : payment_request })
  }

  async payInvoice(paymentRequest: string) : Promise < void > {
    const opts = { payment_request: paymentRequest }
    const resp = await this._lndQuery('sendPaymentSync', opts)
    const error = resp.payment_error

    // TODO find other payment_error types and implement handling for them
    // error handling
    if (error === 'invoice is already paid') {
      throw new Error('Attempted to pay invoice that has already been paid.')
    }

    return resp.payment_preimage
  }

  /******************** Past invoice querying ****************/

  invoiceAmount(invoice: any) : BigNumber {
    return invoice.value
  }

  isFulfilledInvoice(invoice: any) : boolean {
    return invoice.settled
  }

  async getInvoice(paymentRequest: string) : Promise < any > {
    const pastPayments = await this.listInvoices()
    return pastPayments.find((obj: any) => obj.payment_request === paymentRequest)
  }

  async listInvoices() : Promise < any > {
    return (await this._lndQuery('listInvoices', {})).invoices
  }

  /******************** Peering functions ***********************/

	/** attempts to establish a connection to a new peer, does nothing if already
	 * connected
	 * peerAddress: identity pubkey of peer node
	 * peerHost: host:port on peer listening for P2P connections
	 */
  async connectPeer(peerAddress: string, peerHost: string): Promise < string > {
		const opts = { addr : { pubkey: peerAddress, host: peerHost }}
		return await this._lndQuery('connectPeer', opts)
	}

	/** retrieves a list of existing peers and checks if a connection
	 * has already been established
	 */
  async isPeer(peerIdentityPubKey: string): Promise < boolean > {
    // checks if at least one peer w/ peer identity pubkey exists
		return (await this.listPeers()).some(p => p.pub_key === peerIdentityPubKey)
	}

	/** retrieves a list of existing peers */
  async listPeers(): Promise < any[] > {
		return (await this._lndQuery('listPeers', {})).peers
  }

  /********************* Channel maintenance ***************/

  async hasAmount(amt: BigNumber) : Promise < boolean > {
    return (await this.getMaxChannelBalance()) > amt
  }

  async getMaxChannelBalance() : Promise < any > {
    const channels = await this.getChannels()
    const maxChannel = Math.max(...(channels.map(c => c.local_balance)))
    return maxChannel
  }

  async getChannels() : Promise < any[] > {
    const channels = (await this._lndQuery('listChannels', {})).channels
    const activeChannels = channels.filter((c:  any) => c.active)
    return activeChannels
  }

	/* TODO To be implemented later once we delve into the world
	 * of actually establishing connections directly and not just
	 * assuming they're already on lnd */
		/*
  async createChannel(peerPubKey: string, fundingAmt: number, pushAmt: number): Promise < void > {
    // if is peer already:
    const request: Object = {
      node_pubkey_string: peerPubKey,
      local_funding_amt: fundingAmt,
      push_sat: pushAmt
    }
    const call = this.lightning.openChannel(request)
    call.on('data', function (response: string) {
      console.log(response)
    })
    call.on('status', function (status: string) {
			// console.log(status)
    })
    call.on('end', function () {
      console.log(`Channel of amount ${fundingAmt} opened with peer ${peerPubKey}`)
    })
  }

  async _getChannel(pub_key: string): Channel {
    const channels: Channel[] = this.lightning.listChannels()
    const filteredChannels: Channel[] = channels.channels.filter((c: any) => c.remote_pubkey == pub_key)

    // Ensure only one matching channel
    switch (filteredChannels.length) {
      // FIXME currently just returns Channel object, likely should just be chanID
      case 1:
        return filteredChannels[0]
			case 0:
        throw new Error(`Channel connecting account ${this.account.accountName} with public key ` +
					`${this.master.address} does not exist with requested public key: ${pub_key}`)
      default:
        throw new Error(`Unexpected number of channels with public key: ${pub_key}`)
    }
	}
	 */

  /******************* Lnd Connection Maintenance ****************/

	/** wrapper around the actual querying function
	 * methodName: string representing actual function on gRPC
	 * options: request options for method */
  async _lndQuery(methodName: string, options: any): Promise < any > {
    // for any call, ensure we are actually connected to our lnd client
    if (!this.connected) await this.connect()
    // execute lnd request
		try {
			const result = await new Promise((resolve, reject) => {
				this.lightning[methodName](options, function(err: any, response: any) {
					if (err) return reject(err)
					resolve(response)
				})
			})
			return result
		} catch (e) {
			throw e
		}
  }

  /** A few reasons this is placed where it is:
   * 1) Potential chance that connection to lnd client is disrupted
   * at some point after we have already connected once and we need
   * to re-establish the connection
   * 2) It's awkward to call anywhere else because it would necessitate
   * that we not only make an instance of our LndAccount in the index.js
   * or account.js files, but we then have to run .connect() as well
   * 3) The check to ensure it is connected is placed at the beginning
   * of _lndQuery because it only needs to be coded once then instead of
   * at the beginning of every request we make to _lndQuery
   */
  async connect() {
    // Default lnd host and port
    const lndHost: string = 'localhost:10006'
    // get ssl certificate
    const lndCert = await this._getTlsCert()
    // macaroon credentials
    const macaroonCreds = await this._getMacaroonCreds()
    // combine credentials for lnrpc
    const tlsCrds = grpc.credentials.createSsl(lndCert)
    const combinedCredentials = grpc.credentials.combineChannelCredentials(tlsCrds, macaroonCreds)
		// create lightning instance
		// TODO make this path so that typescript compiles it at all times
		const protoPath: string = './utils/rpc.proto'
		const lnrpc = await this._loadDescriptor(protoPath)
    this.lightning = new lnrpc.Lightning(lndHost, combinedCredentials)
    this.connected = true
  }

	/** Loads the gRPC descriptor from the rpc.proto file
	 * so that we can use it to create the lightning client */
	async _loadDescriptor(protoPath: string): Promise < any > {
		let opts = {keepCase: true, longs: String, enums: String, defaults: true, oneofs: true}
		const packageDefinition = await protoLoader.load(protoPath, opts)
		const lnrpcDescriptor = grpc.loadPackageDefinition(packageDefinition)
		return lnrpcDescriptor.lnrpc
	}

	/** Retrieve the tls certificate from the user's local storage,
	 * LND uses macaroons and tls certificates to authenticate
	 * the gRPC client */
  async _getTlsCert(): Promise < string > {
    /* Retrieve default path of tls.cert for lnd according
		 * to operating system of the user */
		const certPath: string = (function (operatingSystem) {
      switch (operatingSystem) {
        case 'darwin':
          return `${process.env.HOME}/Library/Application Support/Lnd/tls.cert`
        case 'linux':
          return `${process.env.HOME}/.lnd/tls.cert`
          // TODO unsure of path for windows, giving it same path as linux currently
        case 'win32':
          return `${process.env.HOME}/.lnd/tls.cert`
        default:
          throw new Error('lnd tls.cert path the OS does not match mac, linux or windows.')
      }
		})(process.platform)

    /* try to access file in certPath, and throw error if file does not exist */
    try {
      return fs.readFileSync(certPath)
    } catch (e) {
      throw new Error('tls.cert does not exist in default location for this OS')
    }
  }

	/** Retrieves path of macaroons according to operating system.  User's 
	 * can pass in their own path, but the connector will default to these paths
	 */
  // TODO change return type to macaroon meta
  async _getMacaroonCreds(): Promise < any > {
    let macaroonPath: string = (function (operatingSystem) {
      switch (operatingSystem) {
        case 'darwin':
          return `${process.env.HOME}/Library/Application Support/Lnd/admin.macaroon`
        case 'linux':
          return `${process.env.HOME}/.lnd/admin.macaroon`
          // TODO unsure of path for windows, giving it same path as linux
        case 'win32':
          return `${process.env.HOME}/.lnd/admin.macaroon`
        default:
          throw new Error('Query for macaroonPath failed because OS does not match mac, linux or windows.')
      }
    })(process.platform)

		// FIXME hardcoding my dee node's path currently just for debugging
    macaroonPath = '/Users/austinking/gocode/dev/ernie/data/chain/bitcoin/simnet/admin.macaroon'

		/* Use path to query file and actually create the gRPC credentials object */
		try {
			let macaroon = fs.readFileSync(macaroonPath).toString('hex');
			let metadata = new grpc.Metadata()
			metadata.add('macaroon', macaroon)
			var macaroonCreds = grpc.credentials.createFromMetadataGenerator(function(_args: any, callback: any) {
				  callback(null, metadata);
			});
			return macaroonCreds
		} catch (e) {
			console.log(e)
      throw new Error('admin.macaroon does not exist in default location for this OS')
    }
  }
}

