const LndPlugin = require('..')
import BtcAccount from '../src/account'
const BigNumber = require('bignumber.js')
import {
  format
} from '../src/account'
/* TODO to figure out how is best to generate
 * wallet credentials for testing. */

let account: BtcAccount

async function createPlugin() {
  return new LndPlugin({
    _balance: {
      minimum: -50000,
      maximum: 100000,
      settleTo: 0,
      settleThreshold: -500000
    }
  })
}

async function createAccount() {
  /*
  return new BtcAccount({
  	accountName: 'test',
  	master: await createPlugin()
  })
   */
}

beforeEach(async() => {
  //	account = await createAccount()
})

afterEach(async() => {})
/*
describe('ilp-plugin-lnd tests', () => {
	describe('addBalance', () => {
		test('do nothing on amount 0', () => {
			const amountToAdd = new BigNumber(0)
			const preBalance = account["account"]["balance"]
			account.addBalance(amountToAdd)
			const postBalance = account["account"]["balance"]
			expect(preBalance).toEqual(postBalance)
		})

		test('throws error if balance exceeds maximum', () => {
			account.addBalance(new BigNumber(99999))
			const amountToAdd = new BigNumber(2)
			expect(account.addBalance(amountToAdd).toThrow()) 
		})

		test('throws error on negative amount', () => {
			//expect(this.mockAccount.addBalance(new BigNumber(-1)).toThrow())
		})
	})
})
*/