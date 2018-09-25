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
  private readonly tlsCertPath: string
  private readonly macaroonPath: string
  private readonly lndHost: string
  constructor(opts: any) {
    // First request connects to lnd
    this.connected = false
    this.tlsCertPath = opts.tlsCertPath
    this.macaroonPath = opts.macaroonPath
    this.lndHost = opts.lndHost
  }

  /** Creates an invoice for the amount requested.  Returns
   * the payment_request which will be sent to the person
   * desiring to pay so that they can complete the payment
   */
  public async addInvoice(amt: number): Promise < any  > {
    return await this._lndQuery('addInvoice', { value : amt })
  }

  public async decodePayReq(paymentRequest: string): Promise < any > {
    return await this._lndQuery('decodePayReq', { pay_req : paymentRequest })
  }

  public async payInvoice(paymentRequest: string): Promise < void > {
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

  public invoiceAmount(invoice: any): BigNumber {
    return invoice.value
  }

  public isFulfilledInvoice(invoice: any): boolean {
    return invoice.settled
  }

  public async getInvoice(paymentRequest: string): Promise < any > {
    const pastPayments = await this._listInvoices()
    return pastPayments.find((obj: any) =>
      obj.payment_request === paymentRequest)
  }

  /******************** Peering functions ***********************/

  /** attempts to establish a connection to a new peer, does nothing if
   * already connected
   * peerAddress: identity pubkey of peer node
   * peerHost: host:port on peer listening for P2P connections
   */
  public async connectPeer(
    peerAddress: string,
    peerHost: string): Promise < string > {
    const opts = { addr : { pubkey: peerAddress, host: peerHost }}
    return await this._lndQuery('connectPeer', opts)
  }

  /** retrieves a list of existing peers and checks if a connection
   * has already been established
   */
  public async isPeer(peerIdentityPubKey: string): Promise < boolean > {
    // checks if at least one peer w/ peer identity pubkey exists
    return (await this.listPeers()).some((p) =>
      p.pub_key === peerIdentityPubKey)
  }

  /** retrieves a list of existing peers */
  public async listPeers(): Promise < any[] > {
    return (await this._lndQuery('listPeers', {})).peers
  }

  /********************* Channel maintenance ***************/

  public async hasAmount(amt: BigNumber): Promise < boolean > {
    return (await this._getMaxChannelBalance()) > amt
  }

  public async getChannels(): Promise < any[] > {
    const channels = (await this._lndQuery('listChannels', {})).channels
    const activeChannels = channels.filter((c: any) => c.active)
    return activeChannels
  }

  /******************* Lnd Connection Maintenance ****************/

  public async connect() {
    // get ssl certificate
    const lndCert = await this._getTlsCert()
    // macaroon credentials
    const macaroonCreds = await this._getMacaroonCreds()
    // combine credentials for lnrpc
    const tlsCreds = grpc.credentials.createSsl(lndCert)
    const combinedCredentials =
      grpc.credentials.combineChannelCredentials(tlsCreds, macaroonCreds)
    // create lightning instance
    // TODO make this path so that typescript compiles it at all times
    const protoPath: string = './utils/rpc.proto'
    const lnrpc = await this._loadDescriptor(protoPath)
    this.lightning = new lnrpc.Lightning(this.lndHost, combinedCredentials)
    this.connected = true
  }

  /** wrapper around the actual querying function
   * methodName: string representing actual function on gRPC
   * options: request options for method
   */
  private async _lndQuery(methodName: string, options: any): Promise < any > {
    // for any call, ensure we are actually connected to our lnd client
    if (!this.connected) {
      await this.connect()
    }
    // execute lnd request
    try {
      const result = await new Promise((resolve, reject) => {
        this.lightning[methodName](options, (err: Error, response: any) => {
          if (err) {
            return reject(err)
          }
          resolve(response)
        })
      })
    } catch (e) {
      throw e
    }
  }

  private async getInfo(): Promise < any > {
    return await this._lndQuery('getInfo', {})
  }

  private async _listInvoices(): Promise < any > {
    return (await this._lndQuery('listInvoices', {})).invoices
  }

  private async _getMaxChannelBalance(): Promise < any > {
    const channels = await this.getChannels()
    const maxChannel = Math.max(...(channels.map((c) => c.local_balance)))
    return maxChannel
  }

  /** Loads the gRPC descriptor from the rpc.proto file
   * so that we can use it to create the lightning client
   */
  private async _loadDescriptor(protoPath: string): Promise < any > {
    const opts = {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true
    }
    const packageDefinition = await protoLoader.load(protoPath, opts)
    const lnrpcDescriptor = grpc.loadPackageDefinition(packageDefinition)
    return lnrpcDescriptor.lnrpc
  }

  /** Retrieve the tls certificate from the user's local storage,
   * LND uses macaroons and tls certificates to authenticate
   * the gRPC client
   */
  private async _getTlsCert(): Promise < string > {
    /* Retrieve default path of tls.cert for lnd according
		 * to operating system of the user */
    const certPath: string = this.tlsCertPath || ((os) => {
      switch (os) {
        case 'darwin':
          return `${process.env.HOME}/Library/Application Support/Lnd/tls.cert`
        case 'linux':
          return `${process.env.HOME}/.lnd/tls.cert`
          // TODO unsure of path for windows, giving it same path as linux
        case 'win32':
          return `${process.env.HOME}/.lnd/tls.cert`
        default:
          throw new Error(`lnd tls.cert path the OS does not match mac, ` +
            `linux or windows.`)
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
  private async _getMacaroonCreds(): Promise < any > {
    const macaroonPath: string = this.macaroonPath || ((os) => {
      switch (os) {
        case 'darwin':
          return `${process.env.HOME}/Library/Application Support/` +
            `Lnd/admin.macaroon`
        case 'linux':
          return `${process.env.HOME}/.lnd/admin.macaroon`
          // TODO unsure of path for windows, giving it same path as linux
        case 'win32':
          return `${process.env.HOME}/.lnd/admin.macaroon`
        default:
          throw new Error(`Query for macaroonPath failed because OS does ` +
            `not match mac, linux or windows.`)
      }
    })(process.platform)

    /* Use path to query file and actually create the gRPC credentials object */
    try {
      const macaroon = fs.readFileSync(macaroonPath).toString('hex')
      const metadata = new grpc.Metadata()
      metadata.add('macaroon', macaroon)
      const macaroonCreds = grpc.credentials.createFromMetadataGenerator(
        (_args: any, callback: any) => callback(null, metadata))
      return macaroonCreds
    } catch (err) {
      throw new Error(`admin.macaroon does not exist in default location ` +
        `for this OS: ${err.message}`)
    }
  }
}
