'use strict'

const grpc = require('grpc')
const debug = require('debug')('ilp-plugin-lnd-asym-server')
const crypto = require('crypto')
const util = require('util')
const fs = require('fs')
const path = require('path')
const os = require('os')
const shared = require('ilp-plugin-shared')
const { InvalidFieldsError } = shared.Errors
const PluginMiniAccounts = require('ilp-plugin-mini-accounts')
const IlpPacket = require('ilp-packet')
const BtpPacket = require('btp-packet')
const { Writer } = require('oer-utils')

// Due to updated ECDSA generated tls.cert we need to let gprc know that
// we need to use that cipher suite otherwise there will be a handhsake
// error when we communicate with the lnd rpc server.
process.env.GRPC_SSL_CIPHER_SUITES = 'HIGH+ECDSA'
const MAC_TLS_CERT_PATH = path.join(os.homedir(), 'Library/Application Support/Lnd/tls.cert')
const LINUX_TLS_CERT_PATH = path.join(os.homedir(), '.lnd/tls.cert')
const MAC_MACAROON_PATH = path.join(os.homedir(), 'Library/Application Support/Lnd/admin.macaroon')
const LINUX_MACAROON_PATH = path.join(os.homedir(), '.lnd/admin.macaroon')

const lnrpcDescriptor = grpc.load(path.join(__dirname, 'rpc.proto'))
const lnrpc = lnrpcDescriptor.lnrpc

const GET_INVOICE_RPC_METHOD = '_get_lightning_invoice'
const ASSET_CODE = 'BTC'
const ASSET_SCALE = 8

class PluginLightning extends PluginMiniAccounts {
  constructor (opts) {
    if (!opts.maxInFlight && !opts.maxUnsecured) {
      throw new InvalidFieldsError('missing opts.maxInFlight')
    } else if (!opts.lndUri) {
      throw new InvalidFieldsError('missing opts.lndUri')
    }

    super(opts)
    process.env.GRPC_SSL_CIPHER_SUITES = 'HIGH+ECDSA'

    this.maxUnsecured = opts.maxUnsecured || opts.maxInFlight
    this.authToken = opts.authToken
    this.lndUri = opts.lndUri

    this.lndTlsCertPath = opts.lndTlsCertPath || (process.platform === 'darwin' ? MAC_TLS_CERT_PATH : LINUX_TLS_CERT_PATH)
    this.macaroonPath = opts.macaroonPath || (process.platform === 'darwin' ? MAC_MACAROON_PATH : LINUX_MACAROON_PATH)
    this.invoices = new Map()
  }

  async _connect () {
    try {
      const lndCert = await util.promisify(fs.readFile)(this.lndTlsCertPath)
      let credentials = grpc.credentials.createSsl(lndCert)

      // Use macaroons also, if there is one in the lnd directory
      // See https://github.com/lightningnetwork/lnd/blob/master/docs/grpc/javascript.md#using-macaroons
      const macaroonExists = await util.promisify(fs.exists)(this.macaroonPath)
      if (macaroonExists) {
        const macaroon = await util.promisify(fs.readFile)(this.macaroonPath)
        const metadata = new grpc.Metadata()
        metadata.add('macaroon', macaroon.toString('hex'))
        const macaroonCreds = grpc.credentials.createFromMetadataGenerator((_args, callback) => {
          callback(null, metadata);
        })
        credentials = grpc.credentials.combineChannelCredentials(credentials, macaroonCreds)
      }

      this.lightning = new lnrpc.Lightning(this.lndUri, credentials)
      debug('connecting to lnd:', this.lndUri)
      const lightningInfo = await util.promisify(this.lightning.getInfo.bind(this.lightning))({})
      debug('got lnd info:', lightningInfo)
    } catch (err) {
      debug('error connecting to lnd', err)
      throw err
    }

    debug('connected to lnd:', this.lndUri)
    this.connected = true
  }

  async _disconnect () {
    debug('disconnect')
    // TODO do we need to disconnect this.lightning?
  }

  async sendMoney (amount) {
    debug(`sendMoney disabled for multi-plugin`)
  }

  async _handleMoney (from, { requestId, data }) {
    const amount = data.amount
    const paymentPreimage = JSON.parse(data
      .protocolData
      .filter(p => p.protocolName === 'payment_preimage')[0]
      .data
      .toString())
      .paymentPreimage

    debug(`handleIncomingClaim for amount: ${amount}, paymentPreimage: ${paymentPreimage}`)

    // If the payment preimage doesn't match an invoice
    // we were waiting for we'll get an error

    const condition = crypto
      .createHash('sha256')
      .update(paymentPreimage, 'hex')
      .digest()
      .toString('hex')

    const invoiceAmount = this.invoices.get(condition)
    if (!invoiceAmount) {
      throw new Error('no invoice found. condition=' + condition)
    }

    if (invoiceAmount !== amount) {
      throw new Error(`settlement amount does not match invoice amount.
        invoice=${invoiceAmount} amount=${amount}`)
    }

    debug(`received lightning payment for ${amount}`)
    this.invoices.delete(condition)

    if (this._moneyHandler) {
      await this._moneyHandler(amount)
    }

    return []
  }

  async _handleData (from, { requestId, data }) {
    const { ilp, protocolMap } = this.protocolDataToIlpAndCustom(data)

    // quickfix for https://github.com/interledgerjs/ilp-plugin-lnd-asym-server/issues/2
    // copied from https://github.com/interledgerjs/ilp-plugin-xrp-asym-server/issues/18
    // TODO: don't do this, use connector only instead
    if (ilp && ilp[0] === IlpPacket.Type.TYPE_ILP_PREPARE && IlpPacket.deserializeIlpPrepare(ilp).destination === 'peer.config') {
      const writer = new Writer()
      debug(`responding to ildcp request`, from)
      const response = from
      writer.writeVarOctetString(Buffer.from(response))
      writer.writeUInt8(ASSET_SCALE)
      writer.writeVarOctetString(Buffer.from(ASSET_CODE, 'utf8'))

      return [{
        protocolName: 'ilp',
        contentType: BtpPacket.MIME_APPLICATION_OCTET_STRING,
        data: IlpPacket.serializeIlpFulfill({
          fulfillment: Buffer.alloc(32),
          data: writer.getBuffer()
        })
      }]
    }

    if (protocolMap[GET_INVOICE_RPC_METHOD]) {
      const amount = protocolMap[GET_INVOICE_RPC_METHOD]

      debug('creating lightning invoice for amount', amount)
      const invoice = await createLightningInvoice(this.lightning, amount)
      this.invoices.set(invoice.r_hash.toString('hex'), amount)

      debug('created lightning invoice:', invoice.payment_request, 'for amount:', amount, 'r_hash:', invoice.r_hash.toString('hex'))
      return [{
        protocolName: GET_INVOICE_RPC_METHOD,
        contentType: BtpPacket.MIME_APPLICATION_JSON,
        data: Buffer.from(JSON.stringify({
          paymentRequest: invoice.payment_request
        }))
      }]
    }

    if (!this._dataHandler) {
      throw new Error('no request handler registered')
    }

    const response = await this._dataHandler(ilp)
    return this.ilpAndCustomToProtocolData({ ilp: response })
  }
}

async function createLightningInvoice (lightning, amount) {
  // TODO when should the lightning invoice expire?
  const invoice = await new Promise((resolve, reject) => {
    lightning.addInvoice({
      value: amount
    }, (err, res) => {
      if (err) return reject(err)
      resolve(res)
    })
  })
  return invoice
}

PluginLightning.version = 2
module.exports = PluginLightning
