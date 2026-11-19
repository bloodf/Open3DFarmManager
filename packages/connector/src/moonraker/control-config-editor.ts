import { createHash } from 'node:crypto'

export const CONFIG_EDITOR_MAX_BYTES = 1024 * 1024

const configName = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,190}\.cfg$/
const digest = (content: Uint8Array) =>
  createHash('sha256').update(content).digest('hex')

type ConfigStorage = {
  list(signal: AbortSignal): Promise<readonly string[]>
  read(path: string, signal: AbortSignal): Promise<Uint8Array>
  write(path: string, content: Uint8Array, signal: AbortSignal): Promise<void>
  remove(path: string, signal: AbortSignal): Promise<void>
  isIdle(signal: AbortSignal): Promise<boolean>
  restart(signal: AbortSignal): Promise<void>
}

export class ConfigWriteRefused extends Error {
  readonly reason:
    'invalid' | 'state' | 'base-mismatch' | 'busy' | 'unauthorized'

  constructor(reason: ConfigWriteRefused['reason']) {
    super(reason)
    this.reason = reason
  }
}

/** Share one editor per printer so writes through separate sessions serialize. */
export function createConfigEditor(storage: ConfigStorage) {
  let busy = false

  async function read(path: string, signal: AbortSignal) {
    const bytes = await storage.read(path, signal)
    if (bytes.byteLength > CONFIG_EDITOR_MAX_BYTES)
      throw new ConfigWriteRefused('invalid')
    return bytes
  }

  return {
    async write(input: {
      path: string
      sha256: string
      base_sha256: string
      content: Uint8Array
      authorize(): boolean
      restart?: boolean
      signal: AbortSignal
    }) {
      const { path, signal } = input
      const content = Buffer.from(input.content)
      if (
        !configName.test(path) ||
        content.byteLength > CONFIG_EDITOR_MAX_BYTES ||
        digest(content) !== input.sha256
      )
        throw new ConfigWriteRefused('invalid')
      if (busy) throw new ConfigWriteRefused('busy')
      busy = true
      const requireAuthorization = () => {
        signal.throwIfAborted()
        if (!input.authorize()) throw new ConfigWriteRefused('unauthorized')
      }
      try {
        requireAuthorization()
        if (!(await storage.isIdle(signal)))
          throw new ConfigWriteRefused('state')
        const previous = await read(path, signal)
        if (digest(previous) !== input.base_sha256)
          throw new ConfigWriteRefused('base-mismatch')
        const prefix = `${path}.openfarm-`
        const backups = (await storage.list(signal))
          .filter((name) => {
            const suffix = name.slice(prefix.length)
            return name.startsWith(prefix) && /^\d{13}\.bak$/.test(suffix)
          })
          .sort()
        const newest = Number(backups.at(-1)?.slice(prefix.length, -4) ?? 0)
        const backup = `${prefix}${Math.max(Date.now(), newest + 1)}.bak`
        requireAuthorization()
        await storage.write(backup, previous, signal)
        if (!(await storage.isIdle(signal)))
          throw new ConfigWriteRefused('state')
        if (digest(await read(path, signal)) !== input.base_sha256)
          throw new ConfigWriteRefused('base-mismatch')
        requireAuthorization()
        await storage.write(path, content, signal)
        for (const old of backups.slice(0, Math.max(0, backups.length - 9))) {
          requireAuthorization()
          await storage.remove(old, signal)
        }
        if (input.restart) {
          if (!(await storage.isIdle(signal)))
            throw new ConfigWriteRefused('state')
          requireAuthorization()
          await storage.restart(signal)
        }
        return backup
      } finally {
        busy = false
      }
    },
  }
}
