export type DataHandler = (data: Buffer) => Promise<Buffer>
export type MoneyHandler = (amount: string) => Promise<void>

import { EventEmitter2 } from 'eventemitter2'

export interface PluginInstance extends EventEmitter2 {
  connect(options: {}): Promise<void>
  disconnect(): Promise<void>
  isConnected(): boolean
  sendData(data: Buffer): Promise<Buffer>
  sendMoney(amount: string): Promise<void>
  registerDataHandler(dataHandler: DataHandler): void
  deregisterDataHandler(): void
  registerMoneyHandler(moneyHandler: MoneyHandler): void
  deregisterMoneyHandler(): void
  getAdminInfo?(): Promise<object>
  sendAdminInfo?(info: object): Promise<object>
}

export interface PluginServices {
  log?: Logger
  store?: Store
}

export interface Logger {
  info(...msg: any[]): void
  warn(...msg: any[]): void
  error(...msg: any[]): void
  debug(...msg: any[]): void
  trace(...msg: any[]): void
}

export interface Store {
  get: (key: string) => Promise<string | void>
  put: (key: string, value: string) => Promise<void>
  del: (key: string) => Promise<void>
}

export class MemoryStore implements Store {
  private _store = new Map<string, string>()

  async get(k: string) {
    return this._store.get(k)
  }

  async put(k: string, v: string) {
    this._store.set(k, v)
  }

  async del(k: string) {
    this._store.delete(k)
  }
}
