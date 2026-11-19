import { createHash } from 'node:crypto'

export const CONFIG_EDITOR_MAX_BYTES = 1024 * 1024

const configName = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,190}\.cfg$/
const digest = (content: Uint8Array) =>
  createHash('sha256').update(content).digest('hex')

function isBackup(path: string, name: string): boolean {
  const prefix = `${path}.openfarm-`
  return (
    name.startsWith(prefix) && /^\d{13}\.bak$/.test(name.slice(prefix.length))
  )
}

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

  async function write(input: {
    path: string
    sha256: string
    base_sha256: string
    content: Uint8Array
    authorize(): boolean
    beforeWrite?(): boolean
    restart?: boolean | undefined
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
      if (!(await storage.isIdle(signal))) throw new ConfigWriteRefused('state')
      const previous = await read(path, signal)
      if (digest(previous) !== input.base_sha256)
        throw new ConfigWriteRefused('base-mismatch')
      const prefix = `${path}.openfarm-`
      const backups = (await storage.list(signal))
        .filter((name) => isBackup(path, name))
        .sort()
      const newest = Number(backups.at(-1)?.slice(prefix.length, -4) ?? 0)
      const backup = `${prefix}${Math.max(Date.now(), newest + 1)}.bak`
      requireAuthorization()
      if (input.beforeWrite && !input.beforeWrite())
        throw new ConfigWriteRefused('unauthorized')
      await storage.write(backup, previous, signal)
      if (!(await storage.isIdle(signal))) throw new ConfigWriteRefused('state')
      if (digest(await read(path, signal)) !== input.base_sha256)
        throw new ConfigWriteRefused('base-mismatch')
      requireAuthorization()
      await storage.write(path, content, signal)
      for (const old of backups.slice(0, Math.max(0, backups.length - 9))) {
        requireAuthorization()
        await storage.remove(old, signal)
      }
      if (digest(await read(path, signal)) !== input.sha256)
        throw new Error('Moonraker did not retain the requested config bytes')
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
  }

  type WriteInput = Parameters<typeof write>[0]
  return {
    async list(signal: AbortSignal) {
      return (await storage.list(signal))
        .filter((path) => configName.test(path))
        .sort()
    },
    async read(path: string, signal: AbortSignal) {
      if (!configName.test(path)) throw new ConfigWriteRefused('invalid')
      const bytes = await read(path, signal)
      const backups = (await storage.list(signal))
        .filter((name) => isBackup(path, name))
        .sort()
        .reverse()
      return { bytes, sha256: digest(bytes), backups }
    },
    write,
    async restore(
      input: Omit<WriteInput, 'content' | 'sha256'> & { backup: string },
    ) {
      if (!configName.test(input.path) || !isBackup(input.path, input.backup))
        throw new ConfigWriteRefused('invalid')
      input.signal.throwIfAborted()
      if (!input.authorize()) throw new ConfigWriteRefused('unauthorized')
      const content = await read(input.backup, input.signal)
      return write({ ...input, content, sha256: digest(content) })
    },
  }
}

/** Construct only with the Connector's validated printer origin. */
export function createMoonrakerConfigEditor(origin: string, apiKey?: string) {
  async function request(
    path: string,
    init: RequestInit & { signal: AbortSignal },
  ) {
    const response = await fetch(new URL(path, origin), {
      ...init,
      redirect: 'error',
      headers: apiKey ? { 'X-Api-Key': apiKey } : {},
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(
        `Moonraker configuration request failed (${response.status})`,
      )
    }
    return response
  }
  const fileUrl = (path: string) =>
    `/server/files/config/${encodeURIComponent(path)}`
  return createConfigEditor({
    async list(signal) {
      const { result } = (await (
        await request('/server/files/list?root=config', { signal })
      ).json()) as {
        result: { path: string; size: number }[]
      }
      return result
        .filter(
          ({ path, size }) =>
            !configName.test(path) || size <= CONFIG_EDITOR_MAX_BYTES,
        )
        .map(({ path }) => path)
    },
    async read(path, signal) {
      const response = await request(fileUrl(path), { signal })
      const reader = response.body?.getReader()
      if (!reader) throw new ConfigWriteRefused('invalid')
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) return Buffer.concat(chunks, size)
          size += chunk.value.byteLength
          if (size > CONFIG_EDITOR_MAX_BYTES)
            throw new ConfigWriteRefused('invalid')
          chunks.push(chunk.value)
        }
      } finally {
        await reader.cancel().catch(() => {})
      }
    },
    async write(path, content, signal) {
      const body = new FormData()
      body.set('root', 'config')
      body.set('file', new Blob([Uint8Array.from(content)]), path)
      await (
        await request('/server/files/upload', { method: 'POST', body, signal })
      ).body?.cancel()
    },
    async remove(path, signal) {
      await (
        await request(fileUrl(path), { method: 'DELETE', signal })
      ).body?.cancel()
    },
    async isIdle(signal) {
      const { result } = (await (
        await request('/printer/objects/query?print_stats', { signal })
      ).json()) as {
        result?: { status?: { print_stats?: { state?: string } } }
      }
      const state = result?.status?.print_stats?.state
      return (
        state === 'standby' || state === 'complete' || state === 'cancelled'
      )
    },
    async restart(signal) {
      await (
        await request('/printer/firmware_restart', { method: 'POST', signal })
      ).body?.cancel()
    },
  })
}
