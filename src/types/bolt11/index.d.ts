/// <reference types="node" />

declare module 'bolt11' {
  export type Tag =
    | {
        tagName: 'payment_hash'
        data: string
      }
    | {
        tagName: 'expire_time'
        data: number
      }
    | {
        tagName: string
        data: any
      }

  function decode(
    payReq: string
  ): {
    coinType: string
    complete: boolean
    satoshis: number | null
    payeeNodeKey: string
    paymentRequest: string
    prefix: 'lnbc20m' | 'lntb20m' | 'lnbcrt20'
    recoveryFlag: 0 | 1 | 2 | 3
    signature: string
    tags: Tag[]
    timestamp: number
    timestampString: string
    wordsTemp: string
  }
}
