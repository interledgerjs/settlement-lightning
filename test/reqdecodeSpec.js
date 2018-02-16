'use strict'

const decodePaymentRequest = require('../src/reqdecode').decodePaymentRequest
const assert = require('chai').assert

const decodePaymentTestCases = [
  {
    reqStr: 'lnsb10n1pdyhr97pp5f6yhzyqq4mrjgfhhw84dvv0y54qryn5rpjhfkdmqcp36lfp0t6jqdqqcqzys0r2m2tcxwmr7lt0gh7xv8t6x6n0unyzztens6a3z5kvpfye3zlyqh4kywjr3ajeqjzh9v4jrv3h53k8rfhmasn922htmh4avh6zcdpgqsws32w',
    req: {
      amount: 1
    }
  },
  {
    reqStr: 'lnsb123450n1pdyhrvdpp59xgem8wm7usdh6gf8thqgc8f4prffvdatlhg039me7qfhgu2yrnqdqqcqzys6rg5ffprhr0jd4e5serxv667ygwntl2896hpwlfa2hu7qk48ufjn2p4tu3tlx23d2ezjnazvmlsmtknjydn6x8kevkmpkmvek03z4uqqt7mk68',
    req: {
      amount: 12345
    }
  }
]

describe('Payment Request Decoder', function () {
  it('should correctly parse payment requests', function () {
    for (let testCase of decodePaymentTestCases) {
      const decodedReq = decodePaymentRequest(testCase.reqStr)
      const expectedReq = testCase.req
      assert.equal(decodedReq.amount, expectedReq.amount, 'Amount does not match ' + decodedReq.amount + ' !=' + expectedReq.amount)
    }
  })
})
