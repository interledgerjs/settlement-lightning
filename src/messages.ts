export interface PeeringRequestMessage {
  type: 'peeringRequest'
  lightningAddress: string
}

export const isPeeringRequestMessage = (o: any): o is PeeringRequestMessage =>
  typeof o === 'object' &&
  typeof o.type === 'string' &&
  o.type === 'peeringRequest' &&
  typeof o.lightningAddress === 'string'

export interface PaymentPreimageMessage {
  type: 'paymentPreimage'
  preimage: string
}

export const isPaymentPreimageMessage = (o: any): o is PaymentPreimageMessage =>
  typeof o === 'object' &&
  typeof o.type === 'string' &&
  o.type === 'paymentPreimage' &&
  typeof o.preimage === 'string' &&
  /[0-9A-Fa-f]{64}/g.test(o.preimage) // 32-byte hex string
