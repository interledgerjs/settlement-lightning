import LightningAccount, { generateBtpRequestId } from '../account'
import BtpPlugin, {
  BtpPacket,
  BtpSubProtocol,
  IlpPluginBtpConstructorOptions
} from 'ilp-plugin-btp'
import { TYPE_MESSAGE, MIME_APPLICATION_OCTET_STREAM } from 'btp-packet'
import { PluginInstance, PluginServices } from '../types/plugin'
import {
  deserializeIlpReply,
  isPrepare,
  deserializeIlpPrepare
} from 'ilp-packet'

export interface LightningClientOpts extends IlpPluginBtpConstructorOptions {
  getAccount: (accountName: string) => LightningAccount
  loadAccount: (accountName: string) => Promise<LightningAccount>
}

export class LightningClientPlugin extends BtpPlugin implements PluginInstance {
  private getAccount: () => LightningAccount
  private loadAccount: () => Promise<LightningAccount>

  constructor(
    { getAccount, loadAccount, ...opts }: LightningClientOpts,
    { log }: PluginServices
  ) {
    super(opts, { log })

    this.getAccount = () => getAccount('peer')
    this.loadAccount = () => loadAccount('peer')

    // If the websocket drops, unload the account
    this.on('disconnect', () => this.getAccount().unload())

    // Peer and re-share invoices if the websocket reconnects
    this.on('connect', () => this._connect())
  }

  async _connect() {
    try {
      // If the account is loaded, assume it's connected
      this.getAccount()
    } catch (err) {
      const account = await this.loadAccount()
      return account.connect()
    }
  }

  _sendMessage(accountName: string, message: BtpPacket) {
    return this._call('', message)
  }

  _handleData(from: string, message: BtpPacket): Promise<BtpSubProtocol[]> {
    return this.getAccount().handleData(message)
  }

  // Add hooks into sendData before and after sending a packet for
  // balance updates and settlement, akin to mini-accounts
  async sendData(buffer: Buffer): Promise<Buffer> {
    const prepare = deserializeIlpPrepare(buffer)
    if (!isPrepare(prepare)) {
      throw new Error('Packet must be a PREPARE')
    }

    const response = await this._call('', {
      type: TYPE_MESSAGE,
      requestId: await generateBtpRequestId(),
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

    const ilpResponse = response.protocolData.find(
      p => p.protocolName === 'ilp'
    )
    if (ilpResponse) {
      const reply = deserializeIlpReply(ilpResponse.data)
      this.getAccount().handlePrepareResponse(prepare, reply)
      return ilpResponse.data
    }

    return Buffer.alloc(0)
  }

  sendMoney(amount: string) {
    return this.getAccount().sendMoney(amount)
  }
}
