'use strict'

const grpc = require('grpc')
const debug = require('debug')('ilp-plugin-lightning')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const BigNumber = require('bignumber.js')
const decodePaymentRequest = require('./reqdecode').decodePaymentRequest
const shared = require('ilp-plugin-shared')
const { InvalidFieldsError, NotAcceptedError } = shared.Errors
const PluginMiniAccounts = require('ilp-plugin-mini-accounts')
const IlpPacket = require ('ilp-packet')
const BtpPacket = require ('btp-packet')
const { Writer } = require('oer-utils')

const lnrpcDescriptor = grpc.load(path.join(__dirname, 'rpc.proto'))
const lnrpc = lnrpcDescriptor.lnrpc

const GET_INVOICE_RPC_METHOD = '_get_lightning_invoice'
const ASSET_CODE = 'BTC'
const ASSET_SCALE = 8

class PluginLightning extends PluginMiniAccounts {
  constructor (opts) {
    if (!opts.lndTlsCertPath) {
      throw new InvalidFieldsError('missing opts.lndTlsCertPath;' +
          ' try /home/YOURNAME/.lnd/tls.cert (Linux) or' +
          ' /Users/YOURNAME/Library/Application Support/Lnd/tls.cert (Mac)')
    } else if (!opts.maxInFlight && !opts.maxUnsecured) {
      throw new InvalidFieldsError('missing opts.maxInFlight')
    } else if (!opts.lndUri) {
      throw new InvalidFieldsError('missing opts.lndUri')
    }

    super(opts)

    this.maxUnsecured = opts.maxUnsecured || opts.maxInFlight
    this.authToken = opts.authToken
    this.lndUri = opts.lndUri

    this.lndTlsCertPath = opts.lndTlsCertPath
    this.invoices = new Map()
  }

  async _connect () {
    const lndTlsCertPath = this.lndTlsCertPath
    try {
      const lndCert = await new Promise((resolve, reject) => {
        fs.readFile(lndTlsCertPath, (err, cert) => {
          if (err) throw err
          resolve(cert)
        })
      })
      this.lightning = new lnrpc.Lightning(this.lndUri, grpc.credentials.createSsl(lndCert))
      debug('connecting to lnd:', this.lndUri)
      const lightningInfo = await new Promise((resolve, reject) => {
        this.lightning.getInfo({}, (err, info) => {
          if (err) return reject(err)
          resolve(info)
        })
      })
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
    return
    debug(`createOutgoingClaim: amountToPay: ${amount}`)

    if (new BigNumber(amount).lessThanOrEqualTo('0')) {
      return
    }

    let paymentRequest
    try {
      const response = await this._call(null, {
        type: BtpPacket.TYPE_MESSAGE,
        requestId: await _requestId(),
        data: { protocolData: [{
          protocolName: GET_INVOICE_RPC_METHOD,
          contentType: BtpPacket.MIME_APPLICATION_JSON,
          data: Buffer.from(JSON.stringify(amount))
        }] }
      })

      paymentRequest = JSON.parse(response
        .protocolData
        .filter(p => p.protocolName === GET_INVOICE_RPC_METHOD)[0]
        .data
        .toString())
        .paymentRequest

      debug('got lightning payment request from peer:', paymentRequest)
    } catch (err) {
      debug('error getting lightning invoice from peer', err)
      throw err
    }

    const paymentPreimage = await payLightningInvoice(this.lightning, paymentRequest, amountToPay)

    await this._call(null, {
      type: BtpPacket.TYPE_TRANSFER,
      requestId: await _requestId(),
      data: {
        amount,
        protocolData: [{
          protocolName: 'payment_preimage',
          contentType: BtpPacket.MIME_APPLICATION_JSON,
          data: Buffer.from(JSON.stringify({ paymentPreimage }))
        }]
      }
    })
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
      .update(paymentPreimage)
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
    if (ilp[0] === IlpPacket.Type.TYPE_ILP_PREPARE && IlpPacket.deserializeIlpPrepare(ilp).destination === 'peer.config') {
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
      const amount = JSON.parse(protocolMap[GET_INVOICE_RPC_METHOD]
        .data
        .toString())

      debug('creating lightning invoice for amount', amount)
      const invoice = await createLightningInvoice(this.lightning, amount)
      this.invoices.set(invoice.r_hash, amount)

      debug('created lightning invoice:', invoice.payment_request, 'for amount:', amount)
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

async function payLightningInvoice (lightning, paymentRequest, amountToPay) {
  // TODO can we check how much it's going to cost before sending? what if the fees are really high?
  debug('sending lightning payment for payment request: ' + paymentRequest)

  // Check that the invoice amount matches the transfer amount
  const decodedReq = decodePaymentRequest(paymentRequest)
  const amountDiff = new BigNumber(decodedReq.amount).sub(amountToPay).absoluteValue()
  if (amountDiff.greaterThan(new BigNumber(amountToPay).times(0.05))) {
    debug('amounts in payment request and in transfer are significantly different:', decodedReq, amountToPay)
    throw new Error(`amounts in payment request and in transfer are significantly different. transfer amount: ${amountToPay}, payment request amount: ${decodedReq.amount}`)
  }

  let result
  try {
    result = await new Promise((resolve, reject) => {
      lightning.sendPaymentSync({
        payment_request: paymentRequest
      }, (err, res) => {
        if (err) return reject(err)
        resolve(res)
      })
    })
  } catch (err) {
    debug('error sending lightning payment for payment request:', paymentRequest, err)
    throw err
  }

  if (result.payment_route && result.payment_preimage) {
    const preimage = result.payment_preimage.toString('hex')
    debug('sent lightning payment for payment request: ' + paymentRequest + ', got payment preimage:', preimage)
    return preimage
  } else {
    debug('error sending lightning payment:', result)
    throw new Error('error sending payment:' + result.payment_error)
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

function hash (preimage) {
  const h = crypto.createHash('sha256')
  h.update(Buffer.from(preimage, 'hex'))
  return h.digest()
}

function hashToUuid (hash) {
  const hex = Buffer.from(hash, 'hex').toString('hex')
  let chars = hex.substring(0, 36).split('')
  chars[8] = '-'
  chars[13] = '-'
  chars[14] = '4'
  chars[18] = '-'
  chars[19] = '8'
  chars[23] = '-'
  return chars.join('')
}

PluginLightning.version = 2
module.exports = PluginLightning
