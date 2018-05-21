const ObjStore = require('ilp-plugin-payment-channel-framework/test/helpers/objStore')
const ServerPluginLightning = require('..')
const ClientPluginLightning = require('ilp-plugin-lnd-asym-client')
const crypto = require('crypto')
const IlpPacket = require('ilp-packet')

function base64url (buf) {
  return buf.toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function sha256 (preimage) {
  return crypto.createHash('sha256').update(preimage).digest()
}

// Alice
const client = new ClientPluginLightning({
  server: 'btp+ws://:pass@localhost:9000',

  maxBalance: '1000000',
  maxUnsecured: '100000',

  lndUri: 'localhost:10001',
  peerPublicKey: process.env.BOB_PUBKEY,
  macaroonPath: process.env.ALICE_MACAROON_PATH,
  lndTlsCertPath: process.env.LND_TLS_CERT_PATH,

  _store: new ObjStore()
})

// Bob
const server = new ServerPluginLightning({
  incomingSecret: 'pass',
  port: 9000,

  maxBalance: '1000000',
  maxUnsecured: '100000',

  lndUri: 'localhost:10002',
  peerPublicKey: process.env.ALICE_PUBKEY,
  macaroonPath: process.env.BOB_MACAROON_PATH,
  lndTlsCertPath: process.env.LND_TLS_CERT_PATH,

  _store: new ObjStore(),

  debugHostIldcpInfo: {
    clientAddress: 'test.server-bob'
  },
})

async function run () {

  server.registerMoneyHandler((amount) => {
    console.log('server got money:', amount)
  })
  server.registerDataHandler((data) => {
    console.log('server got data:', data.toString('utf8'))
  })

  console.log('sending money')
  await client.sendMoney('100')
  console.log('sent money')

  console.log('sending data')
  await client.sendData(Buffer.from('hello world', 'utf8'))
  console.log('sent data')
}

Promise.all([ client.connect(), server.connect() ])
  .then(() => run())
  .then(() => client.disconnect())
  .then(() => server.disconnect())
