const ObjStore = require('ilp-plugin-payment-channel-framework/test/helpers/objStore')
const PluginLightning = require('..')

const crypto = require('crypto')
const IlpPacket = require('ilp-packet')
const uuid = require('uuid/v4')

function base64url (buf) {
  return buf.toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function sha256 (preimage) {
  return crypto.createHash('sha256').update(preimage).digest()
}

// Alice
const client = new PluginLightning({
  server: 'btp+ws://:pass@localhost:9000',

  maxBalance: '1000000', // max allowed balance in Satoshis
  maxUnsecured: '100000', // max that can be sent over Interledger before settlement over Lightning is required

  lndTlsCertPath: process.env.LND_TLS_CERT_PATH,
  lndUri: 'localhost:10001', // lnd rpc URI for Alice
  peerPublicKey: process.env.BOB_PUBKEY,

  _store: new ObjStore()
})

// Bob
const server = new PluginLightning({
  listener: { port: 9000 },
  incomingSecret: 'pass',

  prefix: 'g.bitcoin.lightning.',
  info: {},

  maxBalance: '1000000', // max allowed balance in Satoshis
  maxUnsecured: '100000', // max that can be sent over Interledger before settlement over Lightning is required

  lndTlsCertPath: process.env.LND_TLS_CERT_PATH,
  lndUri: 'localhost:10002', // lnd rpc URI for Bob
  peerPublicKey: process.env.ALICE_PUBKEY,

  _store: new ObjStore()
})

function doPayment() {
  const fulfillment = crypto.randomBytes(32)
  const condition = sha256(fulfillment)

  return new Promise((resolve, reject) => {
    server.on('incoming_prepare', transfer => {
      console.log('Transfer prepared server-side. Condition: ' + transfer.executionCondition)
      server.fulfillCondition(transfer.id, base64url(fulfillment))
    })
    client.on('outgoing_fulfill', function (transferId, fulfillmentBase64) {
      console.log('Transfer executed. Fulfillment: ' + fulfillmentBase64)
      resolve()
    })

    client.sendTransfer({
      ledger: client.getInfo().prefix,
      from: client.getAccount(),
      to: server.getAccount(),
      amount: '12345',
      executionCondition: base64url(condition),
      id: uuid(),
      ilp: base64url(IlpPacket.serializeIlpPayment({
        amount: '12345',
        account: server.getAccount()
      })),
      expiresAt: new Date(new Date().getTime() + 1000000).toISOString()
    }).then(function () {
      console.log('Transfer prepared client-side, waiting for fulfillment...')
    }, function (err) {
      console.error(err.message)
    })
  })
}

Promise.all([ client.connect(), server.connect() ])
  .then(() => doPayment())
  .then(() => new Promise(resolve => setTimeout(resolve, 3000)))
  .then(() => client.disconnect())
  .then(() => server.disconnect())
