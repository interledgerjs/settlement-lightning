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
  private readonly protoPath: string
  constructor(opts: any) {
    // First lnd query connects to lnd
    this.connected = false
    this.tlsCertPath = opts.tlsCertPath
    this.macaroonPath = opts.macaroonPath
    this.lndHost = opts.lndHost
    //this.protoPath = path.join(__dirname, '../src/utils/rpc.proto')
    this.protoPath = './src/utils/rpc.proto'
  }

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
    if (error === 'invoice is already paid') {
      throw new Error('Attempted to pay invoice that has already been paid.')
    }
    return resp.payment_preimage
  }

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

  public async connectPeer(
    peerIdentityPubkey: string,
    peerHost: string): Promise < string > {
    const opts = { addr : { pubkey: peerIdentityPubkey, host: peerHost }}
    return await this._lndQuery('connectPeer', opts)
  }

  public async isPeer(peerIdentityPubKey: string): Promise < boolean > {
    return (await this.listPeers()).some((p) =>
      p.pub_key === peerIdentityPubKey)
  }

  public async listPeers(): Promise < any[] > {
    return (await this._lndQuery('listPeers', {})).peers
  }

  // checks if some channel exists with sufficient funds
  public async hasAmount(amt: BigNumber): Promise < boolean > {
    return (await this._getMaxChannelBalance()) > amt
  }

  public async getChannels(): Promise < any[] > {
    const channels = (await this._lndQuery('listChannels', {})).channels
    const activeChannels = channels.filter((c: any) => c.active)
    return activeChannels
  }

  public async connect() {
    // get tls certificate
    const lndCert = await this._getTlsCert()
    // macaroon credentials
    const macaroonCreds = await this._getMacaroonCreds()
    // combine credentials for lnrpc
    const tlsCreds = grpc.credentials.createSsl(lndCert)
    const combinedCredentials =
      grpc.credentials.combineChannelCredentials(tlsCreds, macaroonCreds)
    // create lightning instance
    const lnrpc = await this._loadDescriptor(this.protoPath)
    this.lightning = new lnrpc.Lightning(this.lndHost, combinedCredentials)
    this.connected = true
  }

  // takes in method and options and communicates with lightning daemon
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
      return result
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

  // load gRPC descriptor from rpc.proto file
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

  // if user didn't pass in tls cert path, get default os location
  private async _getTlsCert(): Promise < string > {
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
    // try to access file in certPath, and throw error if file does not exist
    try {
      return fs.readFileSync(certPath)
    } catch (e) {
      throw new Error('tls.cert does not exist in default location for this OS')
    }
  }

  // if user didn't pass in macaroon path, get default os location
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

    // use path to query file and create the gRPC credentials object
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
