import LightningAccount, { requestId } from '../account'
import BtpPlugin, {
  BtpPacket,
  BtpSubProtocol,
  IlpPluginBtpConstructorOptions
} from 'ilp-plugin-btp'
import { TYPE_MESSAGE, MIME_APPLICATION_OCTET_STREAM } from 'btp-packet'
import { PluginInstance, PluginServices } from '../types/plugin'
import { deserializeIlpPacket, Type } from 'ilp-packet'

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
  }

  _sendMessage(accountName: string, message: BtpPacket) {
    return this._call('', message)
  }

  async _connect(): Promise<void> {
    const account = await this.loadAccount()
    account.emit('connected')
    return account.connect()
  }

  _handleData(from: string, message: BtpPacket): Promise<BtpSubProtocol[]> {
    return this.getAccount().handleData(message)
  }

  // Add hooks into sendData before and after sending a packet for
  // balance updates and settlement, akin to mini-accounts
  async sendData(buffer: Buffer): Promise<Buffer> {
    const preparePacket = deserializeIlpPacket(buffer)
    if (preparePacket.type !== Type.TYPE_ILP_PREPARE) {
      throw new Error('Packet must be a PREPARE')
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

    const ilpResponse = response.protocolData.find(
      p => p.protocolName === 'ilp'
    )
    if (ilpResponse) {
      const responsePacket = deserializeIlpPacket(ilpResponse.data)
      this.getAccount().handlePrepareResponse(preparePacket, responsePacket)
      return ilpResponse.data
    }

    // TODO Should this return a REJECT packet?
    return Buffer.alloc(0)
  }
}
