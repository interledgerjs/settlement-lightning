import { PluginInstance, PluginServices } from '../types/plugin'
import MiniAccountsPlugin from 'ilp-plugin-mini-accounts'
import { ServerOptions } from 'ws'
import { IldcpResponse } from 'ilp-protocol-ildcp'
import { BtpPacket, BtpSubProtocol } from 'ilp-plugin-btp'
import { IlpPacket, IlpPrepare, Type, isPrepare } from 'ilp-packet'
import LightningAccount from '../account'

export interface MiniAccountsOpts {
  port?: number
  wsOpts?: ServerOptions
  debugHostIldcpInfo?: IldcpResponse
  allowedOrigins?: string[]
}

export interface LightningServerOpts extends MiniAccountsOpts {
  getAccount: (accountName: string) => LightningAccount
  loadAccount: (accountName: string) => Promise<LightningAccount>
}

export class LightningServerPlugin extends MiniAccountsPlugin
  implements PluginInstance {
  private getAccount: (address: string) => LightningAccount
  private loadAccount: (address: string) => Promise<LightningAccount>

  constructor(
    { getAccount, loadAccount, ...opts }: LightningServerOpts,
    api: PluginServices
  ) {
    super(opts, api)

    this.getAccount = (address: string) =>
      getAccount(this.ilpAddressToAccount(address))
    this.loadAccount = (address: string) =>
      loadAccount(this.ilpAddressToAccount(address))
  }

  _sendMessage(accountName: string, message: BtpPacket) {
    return this._call(this._prefix + accountName, message)
  }

  _handleCustomData = async (
    from: string,
    message: BtpPacket
  ): Promise<BtpSubProtocol[]> => {
    let account: LightningAccount
    try {
      account = this.getAccount(from)
    } catch (err) {
      account = await this.loadAccount(from)
      await account.connect()
    }

    return account.handleData(message)
  }

  _handlePrepareResponse = async (
    destination: string,
    responsePacket: IlpPacket,
    preparePacket: {
      type: Type.TYPE_ILP_PREPARE
      typeString?: 'ilp_prepare'
      data: IlpPrepare
    }
  ) => {
    if (isPrepare(responsePacket.data)) {
      throw new Error('Received PREPARE in response to PREPARE')
    }

    return this.getAccount(destination).handlePrepareResponse(
      preparePacket.data,
      responsePacket.data
    )
  }

  async sendMoney() {
    throw new Error(
      'sendMoney is not supported: use plugin balance configuration'
    )
  }

  async _close(from: string): Promise<void> {
    this.getAccount(from).unload()
  }
}
