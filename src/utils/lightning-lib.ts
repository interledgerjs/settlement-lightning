const grpc = require('grpc')
import * as fs from 'fs'
const path = require('path')
const isBase64 = require('is-base64')
const protoLoader = require('@grpc/proto-loader')
import BigNumber from 'bignumber.js'

process.env.GRPC_SSL_CIPHER_SUITES = 'HIGH+ECDSA'

export interface LndLibOpts {
  tlsCertInput: string,
  macaroonInput: string,
  lndHost: string,
  grpcPort?: string,
  protoPath?: string
}

export default class LndLib {

  private lightning: any
  private connected: boolean
  private readonly tlsCert: Buffer
  private readonly macaroon: string
  private readonly lndHost: string
  private readonly grpcPort: string
  private readonly protoPath: string
  constructor(opts: LndLibOpts) {
    // First lnd query connects to lnd
    this.connected = false
    if (isBase64(opts.tlsCertInput)) {
      this.tlsCert = Buffer.from(opts.tlsCertInput, 'base64')
    } else if (fs.existsSync(opts.tlsCertInput)) {
      this.tlsCert = fs.readFileSync(opts.tlsCertInput)
    } else {
      throw new Error('TLS Cert is not a valid file or base64 string.')
    }
    if (isBase64(opts.macaroonInput)) {
      this.macaroon =
        Buffer.from(opts.macaroonInput, 'base64').toString('hex')
    } else if (fs.existsSync(opts.macaroonInput)) {
      this.macaroon =
        fs.readFileSync(opts.macaroonInput).toString('hex')
    } else {
      throw new Error('Macaroon is not a valid file or base64 string.')
    }
    this.lndHost = opts.lndHost
    this.grpcPort = opts.grpcPort || '10009'
    this.protoPath = opts.protoPath || path.resolve(__dirname, 'rpc.proto')
  }

  public async addInvoice(): Promise < any  > {
    return await this._lndQuery('addInvoice', {})
  }

  public async subscribeToInvoices(): Promise<any> {
    if (!this.connected) {
      await this.connect()
    }
    const invoices = this.lightning.subscribeInvoices({})
    return invoices
  }

  public async decodePayReq(paymentRequest: string): Promise < any > {
    return await this._lndQuery('decodePayReq', { pay_req : paymentRequest })
  }

  public async queryRoutes(
    pubKey: string,
    amount: string | number | BigNumber,
    numRoutes: string | number | BigNumber = 10): Promise <any> {
    if (!this.connected) {
      await this.connect()
    }
    const opts = {
      pub_key: pubKey,
      amt: amount.toString(),
      num_routes: numRoutes.toString()
    }
    return await this._lndQuery('QueryRoutes', opts)
  }

  public async payInvoice(
    paymentRequest: string,
    amt: BigNumber
  ): Promise < void > {
    const opts = { payment_request: paymentRequest, amt: amt.toNumber() }
    const resp = await this._lndQuery('sendPaymentSync', opts)
    const error = resp.payment_error
    // TODO find other payment_error types and implement handling for them
    if (error === 'invoice is already paid') {
      throw new Error('Attempted to pay invoice that has already been paid.')
      } else if (error === 'unable to find a path to destination') {
        throw new Error('Unable to find route for payment.')
      }
    if (!!error) {
      throw new Error(`Error attempting to send payment: ${error}`)
      }
    return resp.payment_preimage
  }

  public invoiceAmount(invoice: any): BigNumber {
    return new BigNumber(invoice.amt_paid_sat)
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

  public async hasAmount(amt: BigNumber): Promise < boolean > {
    const spendableBalnce = await this._getMaxSpendableBalance()
    return  new BigNumber(spendableBalnce).gt(amt)
  }

  public async getChannels(): Promise < any[] > {
    const channels = (await this._lndQuery('listChannels', {})).channels
    const activeChannels = channels.filter((c: any) => c.active)
    return activeChannels
  }

  public async connect() {
    // get tls certificate
    const lndCert = this.tlsCert
    // macaroon credentials
    const macaroonCreds = await this._getMacaroonCreds()
    // combine credentials for lnrpc
    const tlsCreds = grpc.credentials.createSsl(lndCert)
    const combinedCredentials =
      grpc.credentials.combineChannelCredentials(tlsCreds, macaroonCreds)
    // create lightning instance
    const lnrpc = await this._loadDescriptor(this.protoPath)
    this.lightning =
    new lnrpc.Lightning(this.lndHost + ':' + this.grpcPort, combinedCredentials)
    this.connected = true
  }

  // takes in method and options and communicates with lightning daemon
  private async _lndQuery(methodName: string, options: any): Promise < any > {
    // for any call, ensure we are actually connected to our lnd client
    if (!this.connected) {
      await this.connect()
    }
    // execute lnd request
    return new Promise((resolve, reject) => {
      this.lightning[methodName](options, (err: Error, response: any) => {
        if (err) {
          reject(err)
        }
        resolve(response)
      })
    })
  }

  private async getInfo(): Promise < any > {
    return await this._lndQuery('getInfo', {})
  }

  private async _listInvoices(): Promise < any > {
    const opts = {
      reversed: true
    }
    return (await this._lndQuery('listInvoices', opts)).invoices
  }

  private async _getMaxSpendableBalance(): Promise < any > {
    const channels = await this.getChannels()
    const maxSpendableAmount = channels
      .filter((c) => !!c.local_balance)
      .map((c) => (c.local_balance - (c.capacity * 0.01)))
      .reduce((acc, cur) => Math.max(acc, cur), 0)

    return maxSpendableAmount
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

  // if user didn't pass in macaroon path, get default os location
  private async _getMacaroonCreds(): Promise < any > {
    // use path to query file and create the gRPC credentials object
    try {
      const metadata = new grpc.Metadata()
      metadata.add('macaroon', this.macaroon)
      const macaroonCreds = grpc.credentials.createFromMetadataGenerator(
        (_args: any, callback: any) => callback(null, metadata))
      return macaroonCreds
    } catch (err) {
      throw new Error(`Macaroon is not properly formatted ${err.message}`)
    }
  }
}
