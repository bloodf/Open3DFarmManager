import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startMoonrakerMock } from '../../packages/sim-tools/src/mocks/index.ts'
import { createConfigEditor } from '../../packages/connector/src/moonraker/control-config-editor.ts'

const path = 'printer.cfg'
const original = Buffer.from('[printer]\nmax_velocity: 100\n')
const updated = Buffer.from('[printer]\nmax_velocity: 120\n')
const sha = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex')

let mock: Awaited<ReturnType<typeof startMoonrakerMock>>
let idle: boolean
let editor: ReturnType<typeof createConfigEditor>

const withSignal = (init: RequestInit, signal?: AbortSignal): RequestInit =>
  signal ? { ...init, signal } : init

async function request(path: string, options?: RequestInit) {
  const response = await fetch(mock.origin + path, options)
  if (!response.ok) throw Error(`Moonraker fixture returned ${response.status}`)
  return response
}

const fileUrl = (name: string) =>
  `/server/files/config/${encodeURIComponent(name)}`
async function read(name: string, signal?: AbortSignal) {
  return Buffer.from(
    await (await request(fileUrl(name), withSignal({}, signal))).arrayBuffer(),
  )
}

async function write(name: string, content: Uint8Array, signal?: AbortSignal) {
  const body = new FormData()
  body.set('root', 'config')
  body.set('file', new Blob([Uint8Array.from(content)]), name)
  await (
    await request(
      '/server/files/upload',
      withSignal({ method: 'POST', body }, signal),
    )
  ).body?.cancel()
}

async function list(signal?: AbortSignal): Promise<string[]> {
  const { result } = await (
    await request('/server/files/list?root=config', withSignal({}, signal))
  ).json()
  return result.map((entry: { path: string }) => entry.path)
}

function save(content = updated, base = original) {
  return editor.write({
    path,
    content,
    sha256: sha(content),
    base_sha256: sha(base),
    authorize: () => true,
    signal: AbortSignal.timeout(5000),
  })
}

describe('config editor storage transaction', () => {
  beforeEach(async () => {
    mock = await startMoonrakerMock()
    idle = true
    await write(path, original)
    editor = createConfigEditor({
      read,
      write,
      list,
      async remove(name, signal) {
        await (
          await request(fileUrl(name), withSignal({ method: 'DELETE' }, signal))
        ).body?.cancel()
      },
      async isIdle() {
        return idle
      },
      async restart() {
        throw Error('Unexpected restart')
      },
    })
  })
  afterEach(async () => {
    await mock?.close()
  })

  it('backs up the exact previous bytes before replacing the file', async () => {
    const backup = await save()
    expect(backup).toMatch(/^printer\.cfg\.openfarm-\d{13}\.bak$/)
    expect(await read(backup)).toEqual(original)
    expect(await read(path)).toEqual(updated)
  })

  it('refuses a stale base without touching the config root', async () => {
    await expect(save(updated, updated)).rejects.toThrow('base-mismatch')
    expect(await list()).toEqual([path])
    expect(await read(path)).toEqual(original)
  })

  it('refuses while printing without touching the config root', async () => {
    idle = false
    await expect(save()).rejects.toThrow('state')
    expect(await list()).toEqual([path])
    expect(await read(path)).toEqual(original)
  })

  it('restores backup bytes and backs up the version being replaced', async () => {
    const backup = await save()
    const restored = await save(await read(backup), updated)
    expect(await read(path)).toEqual(original)
    expect(await read(restored)).toEqual(updated)
  })
})
