import { test, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { readRuntimeCredential } from '../../packages/connector/src/config/credential.ts'
import { readAgentRuntimeConfig } from '../../packages/connector/src/config/runtime.ts'
import { loadOrCreateIdentity } from '../../packages/connector/src/identity/store.ts'
import {
  handOverTelemetryScope,
  provisioningQueueDirectory,
} from '../../packages/connector/src/runtime/configuration-command.ts'
import { openScopedTelemetryQueue } from '../../packages/connector/src/runtime/queue-scope.ts'

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'open3d-scope-hand-')))
  const data = join(dir, 'data')
  const state = join(dir, 'state')
  mkdirSync(state, { mode: 0o700 })
  const identity = loadOrCreateIdentity(data)
  const farm = randomUUID()
  const agent = randomUUID()
  const a1 = randomUUID()
  const a2 = randomUUID()
  const credentialPath = join(dir, 'credential.json')
  writeFileSync(
    credentialPath,
    JSON.stringify({
      version: 1,
      expected_fingerprint: identity.fingerprint,
      approval: {
        status: 'approved',
        agent_id: agent,
        farm_id: farm,
        device_token: 'aaa.bbb.ccc',
        expires_at: Date.now() + 60_000,
      },
    }),
    { mode: 0o600 },
  )
  const credential = readRuntimeCredential(
    credentialPath,
    identity.fingerprint,
    Date.now(),
  )
  const assignment = (id: string, key: string, port: number) => ({
    assignment_id: id,
    farm_id: farm,
    agent_id: agent,
    printer_key: key,
    moonraker_origin: `http://127.0.0.1:${port}`,
  })
  const config = (printers: 1 | 2) => ({
    version: 1,
    collection: {
      version: 1,
      allowedOrigins: ['http://127.0.0.1:7125', 'http://127.0.0.1:7126'].slice(
        0,
        printers,
      ),
      printers: [
        { printerKey: 'p1', origin: 'http://127.0.0.1:7125' },
        { printerKey: 'p2', origin: 'http://127.0.0.1:7126' },
      ].slice(0, printers),
      limits: { staleAfterMs: 5000 },
    },
    assignments: [assignment(a1, 'p1', 7125), assignment(a2, 'p2', 7126)].slice(
      0,
      printers,
    ),
    telemetry: {
      endpoint: 'https://127.0.0.1:8443/api/connector/telemetry',
      audience: 'agent-fixture',
    },
  })
  const configPath = join(dir, 'snapshot.json')
  const apply = (printers: 1 | 2) =>
    writeFileSync(configPath, JSON.stringify(config(printers)), { mode: 0o600 })
  const scope = { farm_id: farm, agent_id: agent, stateDirectory: state }
  const events: Record<string, unknown>[] = []
  return {
    dir,
    state,
    scope,
    credential,
    configPath,
    apply,
    events,
    fingerprint: identity.fingerprint,
    open: (directory: string) =>
      openScopedTelemetryQueue({
        dataDirectory: data,
        telemetryDirectory: directory,
        config: readAgentRuntimeConfig(configPath, credential),
        credential,
        now: Date.now(),
      }),
    handover: (fingerprint?: string) =>
      handOverTelemetryScope({
        config: scope,
        configPath,
        fingerprint: fingerprint ?? identity.fingerprint,
        now: Date.now(),
        onDiagnostic: (event) => events.push({ ...event }),
      }),
  }
}

const printerState = (observedAt: number) => ({
  printerKey: 'p1',
  state: 'idle' as const,
  progress: 0,
  observedAt,
})

test('queued telemetry survives an assignment change and is delivered exactly once', () => {
  const f = fixture()
  try {
    f.apply(1)
    const first = f.handover()
    expect(first).toBe(provisioningQueueDirectory(f.scope, f.configPath))
    const q1 = f.open(first)
    const now = Date.now()
    const ids = [now, now + 1].map(
      (at) => q1.enqueue(printerState(at), at).eventId,
    )
    q1.close()

    // Printer p2 is added: the scope directory name changes.
    f.apply(2)
    const second = f.handover()
    expect(second).not.toBe(first)
    expect(existsSync(first)).toBe(false)
    expect(readdirSync(join(f.state, 'telemetry-scopes'))).toHaveLength(1)

    const q2 = f.open(second)
    expect(q2.depth).toBe(2)
    const delivered = q2.batch(Date.now()).records.map((r) => r.eventId)
    expect(delivered).toEqual(ids)
    q2.acknowledge(delivered, Date.now())
    q2.close()

    // Reopening, and a repeated handover, never resend an acknowledged record.
    expect(f.handover()).toBe(second)
    const q3 = f.open(second)
    expect(q3.depth).toBe(0)
    q3.close()

    // Removing p2 again carries the (empty) queue back without loss or replay.
    f.apply(1)
    const third = f.handover()
    const q4 = f.open(third)
    const extra = q4.enqueue(printerState(Date.now()), Date.now()).eventId
    q4.close()
    f.apply(2)
    const fourth = f.handover()
    const q5 = f.open(fourth)
    expect(q5.batch(Date.now()).records.map((r) => r.eventId)).toEqual([extra])
    q5.close()
    expect(f.events.every((e) => e.result === 'carried')).toBe(true)
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test('a handover resumes after a crash that left its staged receipt behind', () => {
  const f = fixture()
  try {
    f.apply(1)
    const first = f.handover()
    const q1 = f.open(first)
    const id = q1.enqueue(printerState(Date.now()), Date.now()).eventId
    q1.close()
    f.apply(2)
    writeFileSync(join(first, 'scope.handover'), 'partial', { mode: 0o600 })
    const target = f.handover()
    expect(target).toBe(provisioningQueueDirectory(f.scope, f.configPath))
    const q2 = f.open(target)
    expect(q2.batch(Date.now()).records.map((r) => r.eventId)).toEqual([id])
    q2.close()
    expect(readdirSync(target)).not.toContain('scope.handover')
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test('a queue owned by another Connector or held by a running one is never adopted', () => {
  const f = fixture()
  try {
    f.apply(1)
    const first = f.handover()
    const q1 = f.open(first)
    q1.enqueue(printerState(Date.now()), Date.now())
    q1.close()
    f.apply(2)

    // Another Connector fingerprint: left untouched, the new scope is empty.
    const foreign = f.handover('f'.repeat(64))
    expect(existsSync(first)).toBe(true)
    expect(foreign).not.toBe(first)
    expect(existsSync(foreign)).toBe(false)

    // A live owner holds the lock: handover refuses and leaves it for review.
    const holder = new TelemetryQueue(first, Date.now())
    try {
      const target = f.handover()
      expect(existsSync(target)).toBe(false)
      expect(f.events.at(-1)).toMatchObject({ result: 'operator-review' })
    } finally {
      holder.close()
    }
    const survivors = new TelemetryQueue(first, Date.now())
    expect(survivors.depth).toBe(1)
    survivors.close()
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
})
