process.env.DEBUG='*'

import LightningLib from '../src/utils/lightning-lib'
const LightningPlugin = require('../src/index')
import BigNumber from 'bignumber.js'

const port = 3000

const serverIdentityPubkey = '033c68de7511aa769eb45c3b03cffb5c231a847f300d67de7107c9808dff7696ec'
const serverMacaroonPath = '/Users/austinking/gocode/dev/ernie/data/chain/bitcoin/simnet/admin.macaroon'
const serverPeeringHost = 'localhost:10016'
const serverLndHost = 'localhost:10006'

const clientIdentityPubkey = '035f98891a132aa23f340fa2ae372be86ea1c46a2a8933321da4a42684e167fea4'
const clientMacaroonPath = '/Users/austinking/gocode/dev/dee/data/chain/bitcoin/simnet/admin.macaroon'
const clientPeeringHost = 'localhost:10015'
const clientLndHost = 'localhost:10005'

async function createServer() {
  const plugin = new LightningPlugin({
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
  const plugin = new LightningPlugin({
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
  const paymentRequest = await client._plugin._account.requestInvoice(invoiceAmount)
  console.log(`Invoice payment request: ${paymentRequest}`)
}

run()
