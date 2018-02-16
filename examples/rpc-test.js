'use strict'

const App = require('koa')
const Router = require('koa-router')
const BodyParser = require('koa-bodyparser')
const Plugin = require('../')
const shared = require('ilp-plugin-shared')
const uuid = require('uuid/v4')
const moment = require('moment')
const crypto = require('crypto')

// NOTE: the configuration must be modified to point to your lnd nodes

const sender = new Plugin({
  peerPublicKey: '037c7d6b68302d53793d8aa8d5a83299239e3a148387bba64589873fe9a376c0ba',
  lndUri: 'localhost:11009',
  rpcUri: 'http://localhost:9002/rpc',
  maxUnsecured: '1000',
  maxBalance: '10000000',
  _store: new shared.ObjStore(),
  authToken: 'token'
})
const receiver = new Plugin({
  peerPublicKey: '02770c79e7eef629aabd4c84396e5cf632893d44dea7248a894f4e80b6cf77060e',
  lndUri: 'localhost:12009',
  rpcUri: 'http://localhost:9001/rpc',
  maxUnsecured: '1000',
  maxBalance: '10000000',
  _store: new shared.ObjStore(),
  authToken: 'token'
})

const rpc1 = Router()
const rpc2 = Router()

rpc1.post('/rpc', async function (ctx) {
  ctx.body = await sender.receive(
    ctx.query.method,
    ctx.request.body)
})

rpc2.post('/rpc', async function (ctx) {
  ctx.body = await receiver.receive(
    ctx.query.method,
    ctx.request.body)
})

new App()
  .use(BodyParser())
  .use(rpc1.routes())
  .use(rpc1.allowedMethods())
  .listen('9001')

new App()
  .use(BodyParser())
  .use(rpc2.routes())
  .use(rpc2.allowedMethods())
  .listen('9002')

function hash (fulfillment) {
  const h = crypto.createHash('sha256')
  h.update(Buffer.from(fulfillment, 'base64'))
  return h.digest()
}

const fulfillment = shared.Util.base64url(crypto.randomBytes(32))
const condition = shared.Util.base64url(hash(fulfillment))
console.log('condition: ', condition, 'fulfillment:', fulfillment)

async function runTest () {

  await sender.connect()
  console.log('sender connected')
  await receiver.connect()
  console.log('receiver connected')
  console.log(`sender balance is: ${await sender.getBalance()}, receiver balance is: ${await receiver.getBalance()}`)

  console.log('submitting first transfer')
  const transfer = {
    id: uuid(),
    from: sender.getAccount(),
    to: receiver.getAccount(),
    ledger: sender.getInfo().prefix,
    amount: '10',
    ilp: 'blah',
    noteToSelf: {
      'just': 'some stuff'
    },
    executionCondition: condition,
    expiresAt: moment().add(5, 'seconds').toISOString(),
    custom: {
      'other': 'thing'
    }
  }

  const receiverFulfilledPromise = new Promise((resolve, reject) => {
    receiver.once('incoming_prepare', async function (transfer) {
      console.log('receiver got incoming prepare notification', transfer)
      console.log(`sender balance is: ${await sender.getBalance()}, receiver balance is: ${await receiver.getBalance()}`)

      console.log('receiver fulfilling first transfer')
      try {
        await receiver.fulfillCondition(transfer.id, fulfillment)
      } catch (err) {
        console.log('error submitting fulfillment', err)
        reject(err)
      }

      console.log(`sender balance is: ${await sender.getBalance()}, receiver balance is: ${await receiver.getBalance()}`)
      resolve()
    })
  })

  await sender.sendTransfer(transfer)
  await receiverFulfilledPromise

  // It will detect if you try to submit a duplicate transaction
  console.log('attempting to send duplicate transfer')
  try {
    const transfer2 = await sender.sendTransfer(transfer)
  } catch (e) {
    console.log('avoided submitting duplicate transfer')
  }
  console.log(`sender balance is: ${await sender.getBalance()}, receiver balance is: ${await receiver.getBalance()}`)

  console.log('sending a transfer that will not be fulfilled')
  const otherTransfer = await sender.sendTransfer(Object.assign({}, transfer, {
    id: uuid()
  }))
  console.log(`sender balance is: ${await sender.getBalance()}, receiver balance is: ${await receiver.getBalance()}`)
  const timedOutPromise = new Promise((resolve) => {
    sender.once('outgoing_cancel', (transfer, rejectionMessage) => {
      console.log('sender got outgoing_reject notification with message:', rejectionMessage)
      resolve()
    })
  })
  await timedOutPromise
  console.log(`sender balance is: ${await sender.getBalance()}, receiver balance is: ${await receiver.getBalance()}`)

  console.log('sending a transfer the receiver will reject')
  receiver.once('incoming_prepare', (transfer) => {
    console.log('receiver got prepared notification, now rejecting transfer')
    receiver.rejectIncomingTransfer(transfer.id, {
      code: 'F06',
      name: 'Unexpected Payment',
      message: 'did not like it',
      triggeredBy: receiver.getAccount(),
      triggeredAt: moment().toISOString()
    })
  })

  const transferToReject = await sender.sendTransfer(Object.assign({}, transfer, {
    id: uuid(),
    expiresAt: moment().add(10, 'seconds').toISOString()
  }))


  const rejectedPromise = new Promise((resolve) => {
    sender.once('outgoing_reject', (transfer, rejectionMessage) => {
      console.log('sender got outgoing_reject notification with message:', rejectionMessage)
      resolve()
    })
  })
  await rejectedPromise
  console.log(`sender balance is: ${await sender.getBalance()}, receiver balance is: ${await receiver.getBalance()}`)

  console.log('plugins can also send messages to one another')
  const messagePromise = new Promise((resolve) => {
    receiver.once('incoming_message', (message) => {
      console.log('receiver got message', message)
      resolve()
    })
  })
  await sender.sendMessage({
    to: receiver.getAccount(),
    data: {
      foo: 'bar'
    }
  })
  await messagePromise

  await sender.disconnect()
  await receiver.disconnect()
  console.log('disconnected plugins')
  process.exit()
}

runTest().catch(err => console.log(err))
