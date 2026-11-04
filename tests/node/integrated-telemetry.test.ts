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
import { PersistentReplayStore } from '../../packages/connector/src/auth/replay.ts'
import { authorizeCommand } from '../../packages/connector/src/auth/verify.ts'
import { parseMoonrakerSnapshot } from '../../packages/connector/src/moonraker/parse.ts'
import {
  createBrowserKey,
  signCommand,
  encodeCommand,
  acceptPairingStart,
} from '@open3dfarmmanager/farm-protocol'

// Component integration only: no network, server authentication or printer execution.
test('identity, synthetic telemetry, replay claims and pairing contracts coexist in one private data directory', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'open3d-component-integration-'))
  let queue: TelemetryQueue | undefined
  let replay: PersistentReplayStore | undefined
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
    replay = new PersistentReplayStore(directory)
    const raw = readFileSync(
      new URL('../fixtures/moonraker/printing.json', import.meta.url),
      'utf8',
    )
    const { printer } = parseMoonrakerSnapshot(raw, {
      printerKey: 'sim-1',
      observedAt: 1000,
    })
    const eventId = queue.enqueue(printer, 1000).eventId
    const pair = await createBrowserKey()
    const id = '00000000-0000-4000-8000-000000000001'
    const command = await signCommand(
      {
        farm_id: id,
        agent_id: id,
        printer_id: id,
        user_id: id,
        key_id: id,
        session_id: id,
        action: 'pause',
      },
      pair.privateKey,
      1000,
    )
    assert.throws(() => queue!.enqueue(command as never, 1000))
    assert.equal(queue.depth, 1)
    const context = {
      farmId: id,
      agentId: id,
      userId: id,
      keyId: id,
      sessionId: id,
      printerIds: new Set([id]),
      now: 1000,
      authorization: { issuedAt: 1000, expiresAt: 61000 },
      key: {
        id,
        farmId: id,
        userId: id,
        role: 'operator' as const,
        revokedAt: null,
        publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey),
      },
    }
    assert.equal(
      authorizeCommand(encodeCommand(command), context, replay).ok,
      true,
    )
    queue.close()
    queue = undefined
    replay.close()
    replay = undefined
    queue = new TelemetryQueue(directory, 1001)
    replay = new PersistentReplayStore(directory)
    assert.deepEqual(
      queue.batch(1001).records.map((record) => record.eventId),
      [eventId],
    )
    assert.deepEqual(
      authorizeCommand(
        encodeCommand(command),
        { ...context, now: 1001 },
        replay,
      ),
      { ok: false, reason: 'replay' },
    )
    assert.equal(
      loadExistingIdentity(directory).fingerprint,
      identity.fingerprint,
    )
    assert.deepEqual(readFileSync(join(directory, 'identity.json')), stored)
    queue.acknowledge([eventId], 1001)
    assert.equal(queue.depth, 0)
  } finally {
    queue?.close()
    replay?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
