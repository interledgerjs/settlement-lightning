import * as IlpPacket from 'ilp-packet'
const btpPacket = require('btp-packet')

import BtpPlugin, { BtpPacket, BtpSubProtocol } from 'ilp-plugin-btp'
import { PluginInstance } from '../utils/types'

import LightningPlugin = require('..')
import LightningAccount, { convert, requestId, Unit } from '../account'
import LightningLib from '../utils/lightning-lib'

export default class LightningClientPlugin
extends BtpPlugin implements PluginInstance {

  private _account: LightningAccount

  constructor(opts: any) {
    super(opts)
    this._account = new LightningAccount({
      master: opts.master,
      // server is single counterparty
      accountName: 'server',
      sendMessage: (message: BtpPacket) => this._call('', message)
    })
  }

  public async _connect(): Promise < void > {
    // sets up peer account & exchanges lnd identity pubkeys
    await this._account.connect()
  }

  public _handleData(
    from: string,
    message: BtpPacket
  ): Promise < BtpSubProtocol[] > {
    return this._account.handleData(message, this._dataHandler)
  }

  public _handleMoney(
    from: string,
    message: BtpPacket
  ): Promise < BtpSubProtocol[] > {
    return this._account.handleMoney(message, this._moneyHandler)
  }

  public async sendData(buffer: Buffer): Promise < Buffer > {
    const preparePacket = IlpPacket.deserializeIlpPacket(buffer)
    const response = await this._call('', {
      type: btpPacket.TYPE_MESSAGE,
      requestId: await requestId(),
      data: {
        protocolData: [{
          protocolName: 'ilp',
          contentType: btpPacket.MIME_APPLICATION_OCTET_STREAM,
          data: buffer
        }]
      }
    })
    const ilpResponse = response.protocolData.filter((p: any) =>
      p.protocolName === 'ilp')[0]
    if (ilpResponse) {
      const responsePacket = IlpPacket.deserializeIlpPacket(ilpResponse.data)
      this._account.handlePrepareResponse(preparePacket, responsePacket)
      return ilpResponse.data
    }
    return Buffer.alloc(0)
  }

  public _disconnect(): Promise < void > {
    return this._account.disconnect()
  }
}
