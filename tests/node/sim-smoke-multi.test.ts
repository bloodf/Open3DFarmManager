import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { runSmoke, type SmokeTarget } from '../../packages/sim-tools/src/cli.ts'

async function startReadyServer() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        result: { klippy_connected: true, klippy_state: 'ready' },
      }),
    )
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert(address && typeof address !== 'string')
  return { server, origin: `http://127.0.0.1:${address.port}` }
}

test('smoke probes and reports every injectable Klipper target', async (t) => {
  const sv06 = await startReadyServer()
  const u1 = await startReadyServer()
  t.after(() => {
    sv06.server.close()
    u1.server.close()
  })

  const messages: string[] = []
  const originalLog = console.log
  console.log = (message?: unknown) => messages.push(String(message))
  t.after(() => {
    console.log = originalLog
  })

  const ready = await runSmoke([
    { name: 'sv06', origin: sv06.origin },
    { name: 'u1', origin: u1.origin },
  ] satisfies SmokeTarget[])

  assert.equal(ready, true)
  assert.deepEqual(messages, [
    'SIM_SMOKE_READY: sv06 Moonraker connected and Klipper ready',
    'SIM_SMOKE_READY: u1 Moonraker connected and Klipper ready',
  ])
})
