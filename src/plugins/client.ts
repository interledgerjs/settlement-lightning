import { TYPE_MESSAGE, MIME_APPLICATION_OCTET_STREAM } from 'btp-packet'
import * as IlpPacket from 'ilp-packet'

import BtpPlugin, { BtpPacket, BtpSubProtocol } from 'ilp-plugin-btp'
import LightningAccount, { requestId } from '../account'
import { PluginInstance, PluginServices } from '../utils/types'

export default class LightningClientPlugin extends BtpPlugin
  implements PluginInstance {
  private _account: LightningAccount

  constructor(opts: any, api: PluginServices) {
    super(opts, api)
    this._account = new LightningAccount({
      master: opts.master,
      // server is only counterparty
      accountName: 'server',
      moneyHandler: async amount => {
        if (this._moneyHandler) {
          return this._moneyHandler(amount)
        }
      },
      sendMessage: (message: BtpPacket) => this._call('', message)
    })
  }

  public async _connect(): Promise<void> {
    // sets up peer account & exchanges lnd identity pubkeys
    this._account.emit('connected')
    await this._account.connect()
  }

  public _handleData(
    from: string,
    message: BtpPacket
  ): Promise<BtpSubProtocol[]> {
    return this._account.handleData(message, this._dataHandler!)
  }

  public async sendData(buffer: Buffer): Promise<Buffer> {
    const preparePacket = IlpPacket.deserializeIlpPacket(buffer)
    if (preparePacket.type !== IlpPacket.Type.TYPE_ILP_PREPARE) {
      throw new Error('Packet must be a PREAPRE')
    }

    const response = await this._call('', {
      type: TYPE_MESSAGE,
      requestId: await requestId(),
      data: {
        protocolData: [
          {
            protocolName: 'ilp',
            contentType: MIME_APPLICATION_OCTET_STREAM,
            data: buffer
          }
        ]
      }
    })
    const ilpResponse = response.protocolData.filter(
      (p: any) => p.protocolName === 'ilp'
    )[0]
    if (ilpResponse) {
      const responsePacket = IlpPacket.deserializeIlpPacket(ilpResponse.data)
      this._account.handlePrepareResponse(preparePacket, responsePacket)
      return ilpResponse.data
    }
    return Buffer.alloc(0)
  }

  public _disconnect(): Promise<void> {
    return this._account.disconnect()
  }
}
