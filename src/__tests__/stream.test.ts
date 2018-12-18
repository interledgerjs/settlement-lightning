import test from 'ava'
import BigNumber from 'bignumber.js'
import getPort from 'get-port'
import {
  createConnection,
  createServer,
  DataAndMoneyStream
} from 'ilp-protocol-stream'
import { performance } from 'perf_hooks'
import LightningPlugin from '..'
import { convert, Unit } from '../account'
import { connectLnd } from '../utils/lightning'

test('client streams data and money to server', async (t: any) => {
  const AMOUNT_TO_SEND = convert(0.0002, Unit.BTC, Unit.Satoshi)
  const SENDER_SETTLE_TO = convert('0.0001', Unit.BTC, Unit.Satoshi)
  const RECEIVER_MAX_BALANCE = new BigNumber(0)
  const port = await getPort()

  // Sender plugin
  const clientPlugin = new LightningPlugin({
    role: 'client',
    // @ts-ignore
    server: `btp+ws://userC:secretC@localhost:${port}`,
    lndIdentityPubkey: process.env.LND_PUBKEY_C!,
    lndHost: process.env.LND_PEERHOST_C!,
    lnd: {
      tlsCert: process.env.LND_TLSCERT_C_BASE64!,
      macaroon: process.env.LND_MACAROON_C_BASE64!,
      lndHost: process.env.LND_PEERHOST_C!
    },
    balance: {
      settleTo: SENDER_SETTLE_TO,
      settleThreshold: convert('0.00009', Unit.BTC, Unit.Satoshi)
    }
  })

  // Rebalance the channel if necessary

  const lightning = connectLnd({
    tlsCert: process.env.LND_TLSCERT_C_BASE64!,
    macaroon: process.env.LND_MACAROON_C_BASE64!,
    lndHost: process.env.LND_PEERHOST_C!
  })

  await lightning.waitForReady()
  const channels = await lightning.getChannels()
  const peerChannel = channels.find(
    c => c.getActive() && c.getRemotePubkey() === process.env.LND_PUBKEY_B!
  )
  if (!peerChannel) {
    return t.fail('no direct channel open between peers for testing purposes')
  }

  const sufficientChannelBalance = AMOUNT_TO_SEND.times(2).lt(
    peerChannel.getLocalBalance()
  )
  const topUpAmount = sufficientChannelBalance ? 0 : AMOUNT_TO_SEND.times(10)
  lightning.disconnect()

  if (!sufficientChannelBalance) {
    t.log('adjusting balance config to top up lightning channel')
  }

  // Receiver plugin
  const serverPlugin = new LightningPlugin({
    role: 'server',
    // @ts-ignore
    port,
    prefix: 'private.asym.children',
    // @ts-ignore
    debugHostIldcpInfo: {
      assetCode: 'BTC',
      assetScale: 8,
      clientAddress: 'private.btc'
    },
    maxPacketAmount: convert(0.000005, Unit.BTC, Unit.Satoshi), // 500 Satoshi
    lndIdentityPubkey: process.env.LND_PUBKEY_B!,
    lndHost: process.env.LND_PEERHOST_B!,
    lnd: {
      tlsCert: process.env.LND_TLSCERT_B_BASE64!,
      macaroon: process.env.LND_MACAROON_B_BASE64!,
      lndHost: process.env.LND_PEERHOST_B!
    },
    balance: {
      maximum: RECEIVER_MAX_BALANCE.plus(topUpAmount),
      settleTo: topUpAmount,
      settleThreshold: 0
    }
  })

  let actualReceived = new BigNumber(0)

  const readyToSend = new Promise(resolve => {
    clientPlugin.registerMoneyHandler(Promise.resolve)
    serverPlugin.registerMoneyHandler(async (amount: string) => {
      actualReceived = actualReceived.plus(amount)
      resolve()
    })
  })

  await serverPlugin.connect()
  await clientPlugin.connect()

  // Wait for the client to finish prefunding
  await readyToSend

  // Setup the receiver (Ethereum server, Stream server)
  const streamServer = await createServer({
    plugin: serverPlugin,
    receiveOnly: true
  })

  const connProm = streamServer.acceptConnection()

  // Setup the sender (Ethereum client, Stream client)
  const clientConn = await createConnection({
    plugin: clientPlugin,
    ...streamServer.generateAddressAndSecret()
  })

  const clientStream = clientConn.createStream()
  clientStream.setSendMax(AMOUNT_TO_SEND)

  const serverConn = await connProm
  const serverStream = await new Promise<DataAndMoneyStream>(resolve => {
    serverConn.once('stream', resolve)
  })

  serverStream.on('money', () => {
    const amountPrefunded = actualReceived.minus(serverConn.totalReceived)

    t.true(
      amountPrefunded.gte(RECEIVER_MAX_BALANCE),
      'amount prefunded to server is always at least the max balance'
    )
    t.true(
      amountPrefunded.lte(SENDER_SETTLE_TO),
      'amount prefunded to server is never greater than settleTo amount'
    )
  })

  const start = performance.now()
  await t.notThrowsAsync(
    serverStream.receiveTotal(AMOUNT_TO_SEND, {
      timeout: 360000
    }),
    'client streamed the total amount of packets to the server'
  )
  t.log(`time: ${performance.now() - start} ms`)

  // Wait 1 seconds for sender to finish settling
  await new Promise(r => setTimeout(r, 1000))

  t.true(
    actualReceived.gte(AMOUNT_TO_SEND),
    'server received at least as much money as the client sent'
  )

  await clientConn.end()
})
