import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createQidiAdapter } from '../../packages/connector/src/qidi/index.ts'
import { startQidiSimulator } from '../../packages/sim-tools/src/qidi-simulator.ts'
import fixture from '../fixtures/qidi/moonraker.json' with { type: 'json' }

// Marker-only payload exercises the adapter's framing check, not JPEG decoding.
const snapshot = Buffer.from([0xff, 0xd8, 0xff, 0xd9])

test('Qidi Moonraker reads and upload over loopback', async (t) => {
  const simulator = await startQidiSimulator({ ...fixture, snapshot })
  t.after(() => simulator.close())
  const directory = await mkdtemp(join(tmpdir(), 'openfarm-qidi-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = join(directory, 'fixture.gcode')
  await writeFile(filePath, '; simulator fixture\n')

  const { origin } = simulator
  const adapter = createQidiAdapter({
    origin,
    auth: { apiKey: 'fixture-key' },
    snapshotPath: '/webcam/?action=snapshot',
  })
  assert.deepEqual(await adapter.discover(), {
    moonrakerVersion: 'v0.8.0',
    klippyConnected: true,
    klippyState: 'ready',
  })
  assert.deepEqual(await adapter.readState(), {
    webhooks: { state: 'ready', state_message: 'Printer is ready' },
    printStats: {
      state: 'printing',
      filename: 'fixture.gcode',
      filament_used: 123.4,
    },
    virtualSdcard: { progress: 0.25 },
    extruder: { temperature: 205.1, target: 210 },
    heaterBed: { temperature: 59.8, target: 60 },
    fan: { speed: 0.5 },
  })
  assert.deepEqual(await adapter.readHistory(), [
    {
      job_id: '000001',
      filename: 'older.gcode',
      status: 'completed',
      filament_used: 164,
    },
  ])
  assert.deepEqual(await adapter.readSnapshot(), snapshot)
  const file = {
    filePath,
    name: 'fixture.gcode',
    signal: new AbortController().signal,
  }
  await adapter.upload(file)
  assert.equal(simulator.uploads.length, 1)
  const [upload] = simulator.uploads
  assert.ok(typeof upload === 'string')
  assert.match(upload, /name="root"\r\n\r\ngcodes/)
  assert.match(upload, /filename="fixture.gcode"/)
  assert.match(upload, /; simulator fixture/)
  assert.doesNotMatch(upload, /name="print"/)

  const anonymous = createQidiAdapter({ origin })
  await assert.rejects(anonymous.discover(), { reason: 'unauthorized' })
  await assert.rejects(anonymous.upload(file), { reason: 'unauthorized' })
  await assert.rejects(anonymous.readSnapshot(), { reason: 'unsupported' })
  assert.throws(
    () => createQidiAdapter({ origin, snapshotPath: '//127.0.0.1:1/webcam' }),
    TypeError,
  )

  const bearer = createQidiAdapter({
    origin,
    auth: { bearerToken: 'fixture-token' },
  })
  assert.equal((await bearer.discover()).klippyConnected, true)
  assert.throws(() => bearer.upload(file), { reason: 'unsupported' })
  const postCount = () =>
    simulator.requests.filter((request) => request.startsWith('POST ')).length
  simulator.setFault('disconnect')
  const before = postCount()
  await assert.rejects(adapter.upload(file), { reason: 'offline' })
  assert.equal(postCount(), before + 1)
})

test('Qidi read failures and absent objects are surfaced', async (t) => {
  const simulator = await startQidiSimulator({
    ...fixture,
    state: { result: { status: { webhooks: { state: 'shutdown' } } } },
    history: undefined,
    snapshot,
  })
  t.after(() => simulator.close())
  const options = { origin: simulator.origin, auth: { apiKey: 'fixture-key' } }
  const adapter = createQidiAdapter(options)
  const state = await adapter.readState()
  assert.deepEqual(state.webhooks, { state: 'shutdown' })
  assert.equal(state.printStats, undefined)
  assert.equal(state.fan, undefined)
  await assert.rejects(adapter.readHistory(), { reason: 'unsupported' })
  simulator.setFault('malformed')
  await assert.rejects(adapter.readState(), { reason: 'invalid-response' })
  simulator.setFault('disconnect')
  await assert.rejects(adapter.discover(), { reason: 'offline' })
  simulator.setFault('timeout')
  await assert.rejects(
    createQidiAdapter({ ...options, timeoutMs: 150 }).discover(),
    { reason: 'timeout' },
  )
})
