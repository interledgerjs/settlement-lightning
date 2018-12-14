/// <reference types="node" />

// TODO Fix this!
declare module 'bolt11' {
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
    tags: {
      tagName: string
      data: any
    }[]
    timestamp: number
    timestampString: string
    wordsTemp: string
  }
}
