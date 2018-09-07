const grpc = require('grpc')
const fs = require('fs')
const process = require('process')
const path = require('path')
const protoLoader = require('@grpc/proto-loader')
const promisify = require('util').promisify
process.env.GRPC_SSL_CIPHER_SUITES = 'HIGH+ECDSA'

const sleep = require('util').promisify(setTimeout)

export default class LndLib {
  /* FIXME currently we don't need the constructor to do
   * anything because the actual initialization is async, 
   * there is def. a cleaner way to do this than just having 
   * an empty constructor then having a .connect() step */
  private lightning: any
  constructor() {}

  async connect() {
    // Default lnd host and port
    const lndHost: string = 'localhost:10006'
    // get ssl certificate
    const lndCert = await this._getCert()
    // macaroon credentials
    const macaroonCreds = await this._getMacaroonCreds()
    // combine credentials for lnrpc
    const sslCreds = grpc.credentials.createSsl(lndCert)
    const combinedCredentials = grpc.credentials.combineChannelCredentials(sslCreds, macaroonCreds)
		// create lightning instance
		// TODO make this path so that typescript compiles it at all times
		const protoPath: string = './utils/rpc.proto'
		const lnrpc = await this._loadDescriptor(protoPath)
		this.lightning = new lnrpc.Lightning(lndHost, combinedCredentials)
  }

  /******************* Calls to lightning daemon *****************/

	/* retrieve general info about one's own lightning daemon,
	 * currently not used anywhere and was implemented for testing
	 * purposes */
	async getInfo(): Promise < any > {
		return await this._lndQuery('getInfo', {})
	}

	/** attempts to establish a connection to a new peer, does nothing if already
	 * connected
	 * peerAddress: identity pubkey of peer node
	 * peerHost: network location of lightning host e.g. localhost:10002
	 */
	async connectPeer(peerAddress: string, peerHost: string): Promise < string > {
		const opts = { addr : { pubkey: peerAddress, host: peerHost }}
		return await this._lndQuery('connectPeer', opts)
	}

	/** retrieves a list of existing peers and checks a connection
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
		 */

	/* Commenting out to prevent tsc errors from not having 
	 * implemented Channel interface yet
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

  /******************* Lnd helpers ****************/

	/** wrapper around the actual querying function
	 * methodName: string representing actual function on gRPC
	 * options: request options for method */
	async _lndQuery(methodName: string, options: any): Promise < any > {
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
  async _getCert(): Promise < string > {
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

		// FIXME hardcoding my dee's node path currently just for debugging
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
