import test from 'ava'
import BigNumber from 'bignumber.js'
import * as getPort from 'get-port'
import * as IlpStream from 'ilp-protocol-stream'
import LightningPlugin = require('..')
import { convert, Unit } from '../account'

test('client streams data and money to server', async (t: any) => {

  const AMOUNT_TO_SEND = convert(0.0002, Unit.BTC, Unit.Satoshi)
  const SENDER_SETTLE_TO = convert('0.0001', Unit.BTC, Unit.Satoshi)
  const RECEIVER_MAX_BALANCE = 0
  const port = await (getPort() as Promise<number>)

  // Sender plugin
  const clientPlugin = new LightningPlugin({
    role: 'client',
    // @ts-ignore
    server: `btp+ws://userC:secretC@localhost:${port}`,
    lndIdentityPubkey: process.env.LND_PUBKEY_C!,
    lndHost: process.env.LND_PEERHOST_C!,
    // @ts-ignore
    lnd: {
      tlsCertInput: process.env.LND_TLSCERT_C!,
      macaroonInput: process.env.LND_MACAROON_C!,
      lndHost: process.env.LND_PEERHOST_C!

    }!,
    balance: {
      settleTo: SENDER_SETTLE_TO,
      settleThreshold: convert('0.00009', Unit.BTC, Unit.Satoshi)
    },
    _log: require('ilp-logger')('ilp-plugin-lnd-client:Sender')
  })

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
    // @ts-ignore
    lnd: {
      // @ts-ignore
      tlsCertInput: process.env.LND_TLSCERT_B!,
      macaroonInput: process.env.LND_MACAROON_B!,
      lndHost: process.env.LND_PEERHOST_B!
    },
    balance: {
      maximum: RECEIVER_MAX_BALANCE
    }
  })

  const sufficientChannelBalance = (await clientPlugin.lnd.getChannels())
    .filter((c: any) => c.remote_pubkey === process.env.LND_PUBKEY_B!)
    .map((c: any) => new BigNumber(c.local_balance).gt(AMOUNT_TO_SEND.times(2)))
  // Top up the sender's outgoing capacity if needed
  if (!sufficientChannelBalance) {
    const payreq = (await clientPlugin.lnd.addInvoice()).payment_request
    await serverPlugin.lnd.payInvoice(payreq, AMOUNT_TO_SEND.times(10))
  }

  let actualReceived = new BigNumber(0)
  clientPlugin.registerMoneyHandler(Promise.resolve)
  serverPlugin.registerMoneyHandler((amount: string) => {
    actualReceived = actualReceived.plus(amount)
  })

  await serverPlugin.connect()
  await clientPlugin.connect()

  const streamServer = await IlpStream.createServer({
    plugin: serverPlugin,
    receiveOnly: true
  })

  let serverStream: IlpStream.DataAndMoneyStream
  let serverConn: IlpStream.Connection
  let clientConn: IlpStream.Connection

  await new Promise(async (resolve: any) => {
    streamServer.once('connection', (conn: IlpStream.Connection) => {
      serverConn = conn

      serverConn.once('stream', (stream: IlpStream.DataAndMoneyStream) => {
        stream.setReceiveMax(AMOUNT_TO_SEND)
        serverStream = stream

        resolve()
      })
    })

    // Setup the sender (Ethereum client, Stream client)
    clientConn = await IlpStream.createConnection({
      plugin: clientPlugin,
      ...(streamServer.generateAddressAndSecret())
    })

    const clientStream = clientConn.createStream()
    clientStream.setSendMax(AMOUNT_TO_SEND)
  })

  serverStream!.on('money', () => {
    const amountPrefunded = actualReceived.minus(serverConn.totalReceived)

    t.true(amountPrefunded.gte(RECEIVER_MAX_BALANCE),
      'amount prefunded to server is always at least the max balance')
    t.true(amountPrefunded.lte(SENDER_SETTLE_TO),
      'amount prefunded to server is never greater than settleTo amount')
  })

  await t.notThrowsAsync(serverStream!.receiveTotal(AMOUNT_TO_SEND),
    'client streamed the total amount of packets to the server')

  // Wait 10 seconds for sender to finish sending payment channel claims
  await new Promise((resolve: any) => {
    setTimeout(resolve, 10000)
  })

  t.true(actualReceived.gte(AMOUNT_TO_SEND),
    'server received at least as much money as the client sent')

  await clientConn!.end()
})
