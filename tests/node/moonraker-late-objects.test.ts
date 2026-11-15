import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serveWsTestServer } from '../unit/ws-serve.ts'
import { openMoonrakerClient } from '../../packages/connector/src/moonraker/client.ts'

test('late objects extend the initial subscription', async () => {
  const requests: Record<string, string[]>[] = []
  let resolveLate!: (value: unknown) => void
  const late = new Promise((resolve) => {
    resolveLate = resolve
  })
  const fixture = await serveWsTestServer({
    http: () => Response.json({}),
    upgrade: () => true,
    onMessage(socket, wire) {
      const request = JSON.parse(wire)
      if (request.method === 'printer.objects.list') {
        setTimeout(
          () =>
            socket.send(
              JSON.stringify({
                jsonrpc: '2.0',
                id: request.id,
                result: { objects: ['fan', 'output_pin caselight'] },
              }),
            ),
          120,
        )
      } else {
        requests.push(request.params.objects)
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              eventtime: 1,
              status: request.params.objects.fan
                ? { fan: { speed: 0.42 }, 'output_pin caselight': { value: 1 } }
                : {},
            },
          }),
        )
      }
    },
  })
  const client = openMoonrakerClient({
    origin: `http://127.0.0.1:${fixture.port}`,
    limits: {
      maxMessageBytes: 4096,
      connectTimeoutMs: 1000,
      requestTimeoutMs: 1000,
      staleAfterMs: 5000,
      reconnectMinMs: 100,
      reconnectMaxMs: 1000,
    },
    signal: new AbortController().signal,
    discoverObjects: true,
    onStatus: resolveLate,
  })
  try {
    await client.snapshot
    const initial = requests[0]
    assert.ok(initial)
    assert.equal(initial.fan, undefined)
    assert.deepEqual(await late, [
      { fan: { speed: 0.42 }, 'output_pin caselight': { value: 1 } },
      1,
    ])
    const extended = requests[1]
    assert.ok(extended)
    assert.deepEqual(extended.fan, ['speed'])
  } finally {
    client.close()
    await client.closed
    await fixture.stop()
  }
})
