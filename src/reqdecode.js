// Library for decoding lnd payment requests
'use strict'

const debug = require('debug')('ilp-plugin-lightning')

function decodePaymentRequest (req) {
  if (!(typeof req === 'string' || req instanceof String)) {
    throw new Error('payment request should be a string')
  }
  if (!req) {
    throw new Error('payment request should not be empty')
  }
  const match = req.match(/ln\w\w(\d+)([munp])(.*)/i)
  debug('matched pay_req', match)

  if (!match) {
    throw new Error('payment request does not look like BOLT-11 format')
  }

  if (match[2] === 'm') { // milli-Bitcoin to Satoshi
    return { amount: parseInt(match[1]) * 100000 }
  }

  if (match[2] === 'u') { // micro-Bitcoin to Satoshi
    return { amount: parseInt(match[1]) * 100 }
  }

  if (match[2] === 'n') { // nano-Bitcoin to Satoshi
    return { amount: parseInt(match[1]) / 10 }
  }

  // 'p', pico-Bitcoin to Satoshi
  return { amount: parseInt(match[1]) / 10000 }
}

exports.decodePaymentRequest = decodePaymentRequest
