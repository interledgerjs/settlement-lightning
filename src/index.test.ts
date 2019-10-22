import BigNumber from 'bignumber.js'
import { createEngine } from '.'
import { hrtime } from 'process'

const defer = <T>(): [Promise<T>, (val: T) => void] => {
  let res: (val: T) => void
  const promise = new Promise<T>(resolve => {
    res = resolve
  })

  /* tslint:disable-next-line:no-unnecessary-type-assertion */
  return [promise, res!]
}

test('Sends and receives Lightning settlements on local simnet', async () => {
  const accountId = 'alice'

  // Setup the context so they each send messages to each other
  const contextA = {
    creditSettlement: jest.fn(),
    trySettlement: jest.fn(),
    sendMessage: (accountId: string, message: any) =>
      engineB.handleMessage(accountId, message)
  }

  const [amountReceived, gotMoney] = defer<[string, BigNumber]>()

  const contextB = {
    creditSettlement: (accountId: string, amount: BigNumber) => {
      gotMoney([accountId, amount])
    },
    trySettlement: jest.fn(),
    sendMessage: jest.fn()
  }

  const startAlice = createEngine({
    macaroon: process.env.ALICE_ADMIN_MACAROON!,
    tlsCert: process.env.ALICE_TLS_CERT!
  })(contextA)

  const startBob = createEngine({
    macaroon: process.env.BOB_ADMIN_MACAROON!,
    tlsCert: process.env.BOB_TLS_CERT!,
    port: process.env.BOB_GRPC_PORT!
  })(contextB)

  const engineA = await startAlice
  const engineB = await startBob

  await engineA.setupAccount(accountId)

  const start = hrtime()

  // Send settlement for some amount of units
  const amountToSettle = new BigNumber(0.0012345)
  const amountSettled = await engineA.settle(accountId, amountToSettle)
  expect(amountSettled).toStrictEqual(amountToSettle)

  await expect(amountReceived).resolves.toStrictEqual([
    accountId,
    amountSettled
  ])

  console.log('Settlement delay: %dms', hrtime(start)[1] / 1000000)

  await Promise.all([engineA.disconnect(), engineB.disconnect()])
}, 20000)

test.todo('Each payment is only credited to one account')
