const grpc = require('grpc')
const fs = require('fs')
const os = require('os')
const path = require('path')
const lnrpc = grpc.load('rpc.proto').lnrpc

process.env.GRPC_SSL_CIPHER_SUITES = 'HIGH+ECDSA'

export default class LndLib {
  /* FIXME currently we don't need the constructor to do
   * anything because the actual initialization is async, 
   * there is def. a cleaner way to do this than just having 
   * an empty constructor then having a .connect() step */
  private lightning: any
  constructor() {}

  async connect() {

    // Default lnd host and port
    const lndHost: string = 'localhost:10009'

    // get ssl certificate
    const lndCert = await this._getCert()

    // macaroon credentials
    const macaroonCreds = await this._getMacaroonCreds()

    // combine credentials for lnrpc
    const sslCreds = grpc.credentials.createSsl(lndCert)
    const combinedCredentials = grpc.credentials.combineChannelCredentials(sslCreds, macaroonCreds)

    // create lightning instance
    this.lightning = new lnrpc.Lightning(lndHost, combinedCredentials)
  }

  /******************* Calls to lightning daemon *****************/

  async getInfo(): Promise < void > {
    const resp = await this.lightning.getInfo()
    console.log(resp)
  }

  // TODO what will this return type be?
  createChannel(peerPubKey: string, fundingAmt: number, pushAmt: number): Promise < void > {
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
      console.log(status)
    })
    call.on('end', function () {
      console.log(`Channel of amount ${fundingAmt} opened with peer ${peerPubKey}`)
    })
  }

  async isPeer(peerIdentityPubKey: string): < boolean > {
    // checks if at least one peer w/ peer identity pubkey existsexists
    const peers: any[] = await listPeers()
    return peers.some(p => p.pub_key === peerIdentityPubKey)
  }

  async connectPeer(peerAddress: string, peerHost: string): Promise < string > {
    // lnd requests this format for this call
    const request: string = `${peerAddress}@${peerHost}`
    return await this.lightning.connectPeer(request)
  }

  async listPeers(): Promise < any[] > {
    return await this.lightning.listPeers()
  }

  async _getChannel(pub_key: string): Channel {
    const channels: Channel[] = this._lightning.listChannels()
    const filteredChannels: Channel[] = channels.channels.filter(c => c.remote_pubkey == pub_key)

    // Ensure only one matching channel
    switch (filteredChannels.length) {
      // FIXME currently just returns Channel object, likely should just be chanID
      case 1:
        return filteredChannels[0]
      case 0:
        throw new Error(`Channel connecting account ${this.account.accountName} with public key ` +
          `${this.master.address} does not exist with requested public key: ${pub_key}`)
      default:
        throw new Error(`Unexpected number of channels with public key: ${pub_key} exist for account ${this.account.accountName}`)
    }
  }

  /******************* Lnd initialization helpers ****************/


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
          throw new Error('In querying for lnd tls.cert path the OS does not match mac, linux or windows.')
      }
    })(os.process())

    /* try to access file in certPath, and throw error if file does not exist */
    try {
      return fs.readFileSync(certPath)
    } catch (e) {
      throw new Error('tls.cert does not exist in default location for this OS')
    }
  }

  // TODO change return type to macaroon meta
  async _getMacaroonCreds(): Promise < any > {
    const macaroonPath: string = (function (operatingSystem) {
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
    })(os.process())

    try {
      const macaroonFile: any = fs.readFileSync(macaroonPath)
      const macaroon: string = macaroonFile.toString('hex')
      let meta = new grpc.Metadata()
      meta.add('macaroon', macaroon)
      return grpc.credentials.createFromMetadataGenerator((_args: any, callback: any) => {
        callback(null, meta)
      })
    } catch (e) {
      throw new Error('admin.macaroon does not exist in default location for this OS')
    }
  }
  /*
	async loadLnd(): Promise<any> {
		let opts = {keepCase: true, longs: String, enums: String, defaults: true, oneofs: true}
		const packageDefinition = await protoLoader.load(this.protoPath, opts)
		const lnrpcDescriptor = grpc.loadPackageDefinition(packageDefinition)
		 */
}