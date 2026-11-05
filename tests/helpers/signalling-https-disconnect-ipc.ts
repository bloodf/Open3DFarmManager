import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'

let initialized = false
let broken = false
let pending: { id: string; finish(error?: Error): void } | undefined
function initializeClient() {
  if (initialized) return
  initialized = true
  process.on('message', (value: unknown) => {
    if (
      !pending ||
      !value ||
      typeof value !== 'object' ||
      !('kind' in value) ||
      value.kind !== 'upgrade-drop-result' ||
      !('id' in value) ||
      value.id !== pending.id ||
      !('ok' in value) ||
      value.ok !== true ||
      Object.keys(value).length !== 3
    ) {
      broken = true
      pending?.finish(new Error('Invalid fixture IPC response'))
      if (process.connected) process.disconnect()
      return
    }
    pending.finish()
  })
  process.on('disconnect', () => {
    broken = true
    pending?.finish(new Error('Fixture IPC disconnected'))
  })
}
export function requestProxyDisconnect(): Promise<void> {
  initializeClient()
  if (!process.send || !process.connected || broken || pending)
    return Promise.reject(new Error('Fixture IPC unavailable or busy'))
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      broken = true
      pending?.finish(new Error('Fixture IPC timeout'))
      if (process.connected) process.disconnect()
    }, 5000)
    pending = {
      id,
      finish(error) {
        clearTimeout(timer)
        pending = undefined
        if (error) reject(error)
        else resolve()
      },
    }
    process.send!(
      { kind: 'upgrade-drop', id },
      undefined,
      undefined,
      (error: Error | null) => {
        if (error) {
          broken = true
          pending?.finish(new Error('Fixture IPC send failed'))
        }
      },
    )
  })
}

export function serveProxyDisconnect(
  child: ChildProcess,
  disconnect: () => Promise<void>,
): void {
  let busy = false
  const seen = new Set<string>()
  child.on('message', (value: unknown) => {
    if (
      !value ||
      typeof value !== 'object' ||
      !('kind' in value) ||
      value.kind !== 'upgrade-drop' ||
      !('id' in value) ||
      typeof value.id !== 'string' ||
      !/^[0-9a-f-]{36}$/.test(value.id) ||
      Object.keys(value).length !== 2 ||
      busy ||
      seen.has(value.id) ||
      seen.size >= 8
    ) {
      child.kill('SIGTERM')
      return
    }
    const id = value.id
    busy = true
    seen.add(id)
    void disconnect()
      .then(() => {
        if (!child.connected || !child.send)
          throw new Error('Fixture IPC disconnected')
        child.send({ kind: 'upgrade-drop-result', id, ok: true }, (error) => {
          if (error) child.kill('SIGTERM')
        })
      })
      .catch(() => child.kill('SIGTERM'))
      .finally(() => {
        busy = false
      })
  })
}
