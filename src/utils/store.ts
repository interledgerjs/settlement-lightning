import { Store } from '../types/plugin'

export class MemoryStore implements Store {
  private _store: Map<string, string>

  constructor() {
    this._store = new Map()
  }

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
