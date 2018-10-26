import LightningPlugin = require('..')

import MiniAccountsPlugin from 'ilp-plugin-mini-accounts'

import * as IlpPacket from 'ilp-packet'
import { BtpPacket, BtpSubProtocol } from 'ilp-plugin-btp'

import LightningAccount from '../account'

import { PluginInstance, PluginServices } from '../utils/types'

export default class LightningServerPlugin extends MiniAccountsPlugin
  implements PluginInstance {
  private _accounts: Map<string, LightningAccount>
  private _master: LightningPlugin

  constructor(opts: any, api: PluginServices) {
    super(opts, api)
    this._master = opts.master
    // one account for each client
    this._accounts = new Map()
  }

  public _connect(address: string, message: BtpPacket): Promise<void> {
    return this._getAccount(address).connect()
  }

  public _handleCustomData = async (
    from: string,
    message: BtpPacket
  ): Promise<BtpSubProtocol[]> =>
    this._getAccount(from).handleData(message, this._dataHandler)

  public _handlePrepareResponse = async (
    destination: string,
    responsePacket: IlpPacket.IlpPacket,
    preparePacket: IlpPacket.IlpPacket
  ): Promise<void> =>
    this._getAccount(destination).handlePrepareResponse(
      preparePacket,
      responsePacket
    )

  public _close(from: string): Promise<void> {
    return this._getAccount(from).disconnect()
  }

  /* Gets the corresponding account for whichever peer we
   * wish to communicate with.  Client does not have this because
   * it only manages one account */
  private _getAccount(address: string) {
    const accountName = this.ilpAddressToAccount(address)
    let account = this._accounts.get(accountName)
    if (!account) {
      account = new LightningAccount({
        accountName,
        master: this._master,
        moneyHandler: async (amount) => {
          if (this._moneyHandler) {
            return this._moneyHandler(amount)
          }
        },
        sendMessage: (message: BtpPacket) => this._call(address, message)
      })
      this._accounts.set(accountName, account)
    }
    return account
  }
}
