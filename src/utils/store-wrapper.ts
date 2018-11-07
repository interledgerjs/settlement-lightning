export interface Store {
  get: (key: string) => Promise<string | void>
  put: (key: string, value: string) => Promise<void>
  del: (key: string) => Promise<void>
}

export default class StoreWrapper {
  private _store?: Store
  private _cache: Map<string, string | void | object>
  private _write: Promise<void>

  constructor(store: Store) {
    this._store = store
    this._cache = new Map()
    this._write = Promise.resolve()
  }

  public async load(key: string) { return this._load(key, false) }
  public async loadObject(key: string) { return this._load(key, true) }

  public unload(key: string) {
    if (this._cache.has(key)) {
      this._cache.delete(key)
    }
  }

  public get(key: string): string | void {
    const val = this._cache.get(key)
    if (val === undefined || typeof val === 'string') {
      return val
    }
    throw new Error('StoreWrapper#get: unexpected type for key=' + key)
  }

  public getObject(key: string): object | void {
    const val = this._cache.get(key)
    if (val === undefined || typeof val === 'object') {
      return val
    }
    throw new Error('StoreWrapper#getObject: unexpected type for key=' + key)
  }

  public set(key: string, value: string | object) {
    this._cache.set(key, value)
    const valueStr = typeof value === 'object' ? JSON.stringify(value) : value
    this._write = this._write.then(() => {
      if (this._store) {
        return this._store.put(key, valueStr)
      }
    })
  }

  public delete(key: string) {
    this._cache.delete(key)
    this._write = this._write.then(() => {
      if (this._store) {
        return this._store.del(key)
      }
    })
  }

  public setCache(key: string, value: string) {
    this._cache.set(key, value)
  }

  public close(): Promise<void> { return this._write }

  private async _load(key: string, parse: boolean) {
    if (!this._store) {
      return
    }
    if (this._cache.has(key)) {
      return
    }
    const value = await this._store.get(key)
    // once the call returns, double-check that the cache is still empty.
    if (!this._cache.has(key)) {
      this._cache.set(key, (parse && value) ? JSON.parse(value) : value)
    }
  }
}
