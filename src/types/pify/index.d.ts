import { PromisifySome } from '../promisify'

declare module 'pify' {
  function pify<T extends {}, U extends keyof T>(
    input: T,
    opts?: {
      exclude?: Array<U>
    }
  ): PromisifySome<T, U>
}

export default pify
