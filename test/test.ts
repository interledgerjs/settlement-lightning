process.env.DEBUG = '*'

import LightningLib from '../src/utils/lightning-lib'
const lightningPlugin = require('../src/index')
import BigNumber from 'bignumber.js'

const port = 3000

const serverIdentityPubkey = ''
const serverMacaroonPath = ''
const serverPeeringHost = ''
const serverLndHost = ''

const clientIdentityPubkey = ''
const clientMacaroonPath = ''
const clientPeeringHost = ''
const clientLndHost = ''

async function createServer() {
  const plugin = new lightningPlugin({
    role: 'server',
    maxPacketAmount: 100,
    port,
    lndIdentityPubkey: serverIdentityPubkey,
    lndPeeringHost: serverPeeringHost,
    lndHost: serverLndHost,
    macaroonPath: serverMacaroonPath,
    debugHostIldcpInfo: {
      clientAddress: 'test.prefix',
      assetScale: 9,
      assetCode: 'BTC'
    }
  })
  return plugin
}

async function createClient() {
  const plugin = new lightningPlugin({
    role: 'client',
    server: `btp+ws://:secret@localhost:${port}`,
    lndIdentityPubkey: clientIdentityPubkey,
    lndPeeringHost: clientPeeringHost,
    lndHost: clientLndHost,
    macaroonPath: clientMacaroonPath
  })
  return plugin
}

async function run() {
  const server = await createServer()
  await server.connect()
  const client = await createClient()
  await client.connect()
  const invoiceAmount = new BigNumber(99)
  const paymentRequest =
    await client._plugin._account.requestInvoice(invoiceAmount)
  console.log(`Invoice payment request: ${paymentRequest}`)
}

run()
