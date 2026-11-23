import { listMoonrakerFiles } from '../../packages/connector/src/moonraker/files.ts'
import { moonrakerQueryClient } from '../../packages/connector/src/runtime/api-query-moonraker.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fileOperationAcknowledged,
  prepareFileOperation,
} from '../../packages/connector/src/moonraker/control-file-manager.ts'
import {
  startMoonrakerMock,
  type MoonrakerMockInstance,
} from '../../packages/sim-tools/src/mocks/moonraker-mock.ts'

let mock: MoonrakerMockInstance | undefined
afterEach(async () => {
  await mock?.close()
})

async function connect() {
  const ws = new WebSocket(mock!.origin.replace('http:', 'ws:') + '/websocket')
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  let id = 0
  return {
    close: () => ws.close(),
    request(method: string, params: object) {
      return new Promise<unknown>((resolve, reject) => {
        const requestId = ++id
        const receive = ({ data }: MessageEvent) => {
          const message = JSON.parse(data)
          if (message.id !== requestId) return
          ws.removeEventListener('message', receive)
          if (message.error) reject(Error(message.error.message))
          else resolve(message.result)
        }
        ws.addEventListener('message', receive)
        ws.send(
          JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
        )
      })
    },
  }
}

describe('Moonraker file operations', () => {
  it('creates a folder, moves a file into it, and deletes the moved file', async () => {
    mock = await startMoonrakerMock({
      files: [{ path: 'part.gcode', content: 'G28' }],
    })
    const client = await connect()
    try {
      for (const args of [
        { op: 'mkdir', path: 'parts' },
        { op: 'move', path: 'part.gcode', to: 'parts/part.gcode' },
        { op: 'delete', path: 'parts/part.gcode' },
      ]) {
        const call = await prepareFileOperation(args, client.request)
        expect(
          fileOperationAcknowledged(
            await client.request(call.method, call.params),
            args,
          ),
        ).toBe(true)
      }
      const query = moonrakerQueryClient(mock.origin, {
        maxMessageBytes: 4096,
        requestTimeoutMs: 1000,
        connectTimeoutMs: 1000,
        staleAfterMs: 2000,
        reconnectMinMs: 100,
        reconnectMaxMs: 200,
      })
      expect(
        await listMoonrakerFiles(query, { limit: 200, directory: '' }),
      ).toEqual([{ name: 'parts', directory: true, modified: 0, size: 0 }])
      expect(
        await listMoonrakerFiles(query, { limit: 200, directory: 'parts' }),
      ).toEqual([])
    } finally {
      client.close()
    }
  })

  it.each([
    { op: 'delete', path: '../config/printer.cfg' },
    { op: 'move', path: 'part.gcode', to: '/config/printer.cfg' },
    { op: 'mkdir', path: 'parts/%2e%2e' },
    { op: 'delete', path: 'parts\\..\\printer.cfg' },
  ])('refuses unsafe paths before requesting state: %j', async (args) => {
    const read = vi.fn()
    await expect(prepareFileOperation(args, read)).rejects.toMatchObject({
      refusal: 'invalid-command',
    })
    expect(read).not.toHaveBeenCalled()
  })

  it('refuses deletion while the file is printing', async () => {
    mock = await startMoonrakerMock({
      initial: { state: 'printing', filename: 'part.gcode' },
      files: [{ path: 'part.gcode', content: 'G28' }],
    })
    const client = await connect()
    try {
      await expect(
        prepareFileOperation(
          { op: 'delete', path: 'part.gcode' },
          client.request,
        ),
      ).rejects.toMatchObject({ refusal: 'state' })
      expect(
        await client.request('server.files.list', { root: 'gcodes' }),
      ).toMatchObject([{ path: 'part.gcode' }])
    } finally {
      client.close()
    }
  })
})
