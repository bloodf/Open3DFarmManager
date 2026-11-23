import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadOrCreateIdentity,
  loadExistingIdentity,
} from '../../packages/connector/src/identity/store.ts'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { parseMoonrakerSnapshot } from '../../packages/connector/src/moonraker/parse.ts'
import { acceptPairingStart } from '@open3dfarmmanager/farm-protocol'
import { decodeCommandV2 } from '../../packages/farm-protocol/src/command-v2.ts'
import {
  createV2Authority,
  nodeSigner,
  openV2Dispatch,
  rejected,
  type V2Dispatch,
} from '../helpers/command-v2-dispatch.ts'

// Component integration only: no network, server authentication or printer execution.
test('identity, synthetic telemetry, replay claims and pairing contracts coexist in one private data directory', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'open3d-component-integration-'))
  let queue: TelemetryQueue | undefined
  let commands: V2Dispatch | undefined
  try {
    const identity = loadOrCreateIdentity(directory)
    const stored = readFileSync(join(directory, 'identity.json'))
    const start = acceptPairingStart(
      {
        device_code: 'A'.repeat(43),
        user_code: 'BCDF2345',
        fingerprint: identity.fingerprint,
        issued_at: 1000,
        expires_at: 901000,
        poll_interval_s: 5,
      },
      identity.fingerprint,
      1000,
    )
    assert.equal(start.fingerprint, identity.fingerprint)
    queue = new TelemetryQueue(directory, 1000)
    const authority = await createV2Authority(await nodeSigner())
    commands = await openV2Dispatch(authority, { directory })
    const raw = readFileSync(
      new URL('../fixtures/moonraker/printing.json', import.meta.url),
      'utf8',
    )
    const { printer } = parseMoonrakerSnapshot(raw, {
      printerKey: 'sim-1',
      observedAt: 1000,
    })
    const eventId = queue.enqueue(printer, 1000).eventId
    const wire = await authority.sign({}, 1050)
    assert.throws(() => queue!.enqueue(decodeCommandV2(wire) as never, 1000))
    assert.equal(queue.depth, 1)
    commands.advance(60)
    assert.equal((await commands.dispatch(wire)).kind, 'applied')
    queue.close()
    queue = undefined
    commands.close()
    commands = undefined
    queue = new TelemetryQueue(directory, 1001)
    commands = await openV2Dispatch(authority, { directory, now: 1050 })
    commands.advance(100)
    assert.deepEqual(
      queue.batch(1001).records.map((record) => record.eventId),
      [eventId],
    )
    assert.deepEqual(await commands.dispatch(wire), rejected('replay'))
    assert.equal(
      loadExistingIdentity(directory).fingerprint,
      identity.fingerprint,
    )
    assert.deepEqual(readFileSync(join(directory, 'identity.json')), stored)
    queue.acknowledge([eventId], 1001)
    assert.equal(queue.depth, 0)
  } finally {
    queue?.close()
    commands?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
