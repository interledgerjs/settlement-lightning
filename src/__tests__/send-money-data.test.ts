import anyTest, { TestInterface } from 'ava'
import BigNumber from 'bignumber.js'
import getPort from 'get-port'
import LightningPlugin from '..'
import { convert, Unit } from '../account'
import { createHash, randomBytes } from 'crypto'
import { promisify } from 'util'
import {
  IlpPrepare,
  IlpFulfill,
  serializeIlpPrepare,
  serializeIlpFulfill
} from 'ilp-packet'
import { base64url } from 'btp-packet'

const test = anyTest as TestInterface<{
  clientPlugin: LightningPlugin
  serverPlugin: LightningPlugin
}>

test.beforeEach(async t => {
  const port = await getPort()

  const token = 'secret'
  const clientPlugin = new LightningPlugin({
    role: 'client',
    server: `btp+ws://:${token}@localhost:${port}`,
    lnd: {
      tlsCert: process.env.LND_TLSCERT_C_BASE64!,
      macaroon: process.env.LND_MACAROON_C_BASE64!,
      hostname: process.env.LND_PEERHOST_C!,
      grpcPort: parseInt(process.env.LND_GRPCPORT_C!, 10)
    }
  })

  const serverPlugin = new LightningPlugin({
    role: 'server',
    port,
    debugHostIldcpInfo: {
      assetCode: 'BTC',
      assetScale: 8,
      clientAddress: 'private.btc'
    },
    lnd: {
      tlsCert: process.env.LND_TLSCERT_B_BASE64!,
      macaroon: process.env.LND_MACAROON_B_BASE64!,
      hostname: process.env.LND_PEERHOST_B!,
      grpcPort: parseInt(process.env.LND_GRPCPORT_B!, 10)
    }
  })

  await serverPlugin.connect()
  await clientPlugin.connect()

  t.context = {
    clientPlugin,
    serverPlugin
  }
})

test.afterEach(async t => {
  const { clientPlugin, serverPlugin } = t.context

  await serverPlugin.disconnect()
  await clientPlugin.disconnect()

  clientPlugin.deregisterDataHandler()
  serverPlugin.deregisterDataHandler()

  clientPlugin.deregisterMoneyHandler()
  serverPlugin.deregisterMoneyHandler()
})

test('sends money and data between clients and servers', async t => {
  t.plan(6)

  const PREFUND_AMOUNT = convert(0.0002, Unit.BTC, Unit.Satoshi)
  const SEND_AMOUNT = convert(0.00014, Unit.BTC, Unit.Satoshi)

  const { clientPlugin, serverPlugin } = t.context

  clientPlugin.registerMoneyHandler(async () => {
    t.fail(`server sent money to client when it wasn't supposed to`)
  })

  // Prefund the server
  await new Promise(async resolve => {
    serverPlugin.registerMoneyHandler(async amount => {
      t.true(
        new BigNumber(amount).isEqualTo(PREFUND_AMOUNT),
        'server receives exactly the amount the client prefunded'
      )
      resolve()
    })

    await t.notThrowsAsync(clientPlugin.sendMoney(PREFUND_AMOUNT.toString()))
  })

  serverPlugin.deregisterMoneyHandler()
  serverPlugin.registerMoneyHandler(async () => {
    t.fail(`client sent money to the server when it wasn't supposed to`)
  })

  await new Promise(async resolve => {
    const destination = `private.btc.${base64url(
      createHash('sha256')
        .update('secret')
        .digest()
    )}`
    const fulfillment = await promisify(randomBytes)(32)
    const condition = createHash('sha256')
      .update(fulfillment)
      .digest()

    const prepare: IlpPrepare = {
      destination,
      amount: SEND_AMOUNT.toString(),
      executionCondition: condition,
      expiresAt: new Date(Date.now() + 5000),
      data: Buffer.alloc(0)
    }

    const fulfill: IlpFulfill = {
      fulfillment,
      data: Buffer.alloc(0)
    }

    serverPlugin.registerDataHandler(data => {
      t.true(
        data.equals(serializeIlpPrepare(prepare)),
        'server receives PREPARE from client'
      )

      return serverPlugin.sendData(data)
    })

    clientPlugin.registerDataHandler(async data => {
      t.true(
        data.equals(serializeIlpPrepare(prepare)),
        'server forwards PREPARE packet'
      )

      clientPlugin.deregisterMoneyHandler()
      clientPlugin.registerMoneyHandler(async amount => {
        t.true(
          new BigNumber(amount).isEqualTo(SEND_AMOUNT),
          'server will send settlement to client for value of fulfilled packet'
        )
        resolve()
      })

      return serializeIlpFulfill(fulfill)
    })

    const reply = await clientPlugin.sendData(serializeIlpPrepare(prepare))
    t.true(
      reply.equals(serializeIlpFulfill(fulfill)),
      'server returns FULFILL packet to client'
    )
  })
})
