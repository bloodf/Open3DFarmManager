import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readMoonrakerFirmware } from '../../packages/connector/src/moonraker/firmware.ts'

test('reads firmware with only the read-only status RPC', async () => {
  const methods: string[] = []
  const client = {
    async request(method: string, params: object): Promise<unknown> {
      const request = JSON.parse(
        JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      )
      methods.push(request.method)
      assert.deepEqual(request.params, {})
      const reply = JSON.parse(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            version_info: {
              klipper: { version: 'v1', remote_version: 'v2' },
              moonraker: { version: 'm1', remote_version: 'm1' },
              system: { version: 's'.repeat(80) },
            },
          },
        }),
      )
      return reply.result
    },
  }
  assert.deepEqual(await readMoonrakerFirmware(client), {
    current: 'v1',
    latest: 'v2',
    updateAvailable: true,
    components: [
      { name: 'klipper', current: 'v1', latest: 'v2' },
      { name: 'moonraker', current: 'm1', latest: 'm1' },
      { name: 'system', current: 's'.repeat(64) },
    ],
  })
  assert.deepEqual(methods, ['machine.update.status'])
  assert.equal(
    await readMoonrakerFirmware({ request: async () => ({}) }),
    undefined,
  )
})
