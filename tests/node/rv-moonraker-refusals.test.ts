// #884: a pre-write refusal on any Moonraker printer ends as not sent, so it
// never leaves an unknown outcome that blocks the printer's later commands.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { createOfflineAuthority } from '../../packages/connector/src/auth/offline-authority.ts'
import {
  closeCommandJournal,
  openCommandJournal,
  readCommandOutcome,
} from '../../packages/connector/src/control/command-journal.ts'
import { DriverRefusalError } from '../../packages/connector/src/control/driver-refusal.ts'
import { createPrinterBindingRegistry } from '../../packages/connector/src/control/printer-binding.ts'
import { buildMoonrakerCommand } from '../../packages/connector/src/moonraker/commands.ts'
import { openFixedMoonrakerPause } from '../../packages/connector/src/moonraker/pause-driver.ts'
import { SNAPMAKER_U1_MARKER } from '../../packages/connector/src/moonraker/u1-marker.ts'
import { createApiCommandRunner } from '../../packages/connector/src/runtime/api-command.ts'
import { createPauseDriverRouter } from '../../packages/connector/src/runtime/pause-driver-router.ts'
import {
  API_ENVELOPE_ISSUER,
  encodeApiEnvelopeFrame,
  newApiEnvelopeNonce,
  scopeForApiCommand,
  signApiEnvelope,
} from '../../packages/farm-protocol/src/api-envelope.ts'
import {
  startMoonrakerMock,
  type MoonrakerMockOptions,
} from '../../packages/sim-tools/src/mocks/moonraker-mock.ts'
import {
  createV2Authority,
  nodeSigner,
  openV2Dispatch,
  type ExtendedControlAction,
} from '../helpers/command-v2-dispatch.ts'

const limits = {
  maxMessageBytes: 65536,
  connectTimeoutMs: 2000,
  requestTimeoutMs: 2000,
  staleAfterMs: 2000,
  reconnectMinMs: 100,
  reconnectMaxMs: 100,
}
const jog = { axis: 'x', distance_mm: 10, feed: 600 }
const actions = [
  'jog',
  'set_temperature',
  'set_fan',
  'home',
] satisfies ExtendedControlAction[]

/** A generic (not U1) Moonraker printer behind the real dispatcher. */
async function world(t: TestContext, options: MoonrakerMockOptions = {}) {
  const authority = await createV2Authority(await nodeSigner())
  const remote = await startMoonrakerMock({ profile: 'sv06', ...options })
  t.after(() => remote.close())
  let retired: Promise<void> | undefined
  const session = await openV2Dispatch(authority, {
    capability: { role: 'owner', actions },
    loopback: {
      origin: remote.origin,
      driver({ clock, observe }) {
        const router = createPauseDriverRouter({
          allowedOrigins: [remote.origin],
          limits,
          clock,
          observe,
        })
        return {
          ...router,
          closeAttempt(binding) {
            retired = router.closeAttempt(binding)
            return retired
          },
        }
      },
    },
  })
  t.after(() => session.close())
  async function run(
    action: ExtendedControlAction,
    args: Record<string, unknown>,
  ) {
    retired = undefined
    const result = await session.dispatch(
      await authority.sign(
        { action, args, purpose: 'printer-control' },
        session.now(),
      ),
    )
    await retired
    return result
  }
  async function notSent(
    action: ExtendedControlAction,
    args: Record<string, unknown>,
    reason: DriverRefusalError['refusal'],
  ) {
    const result = await run(action, args)
    assert.equal(result.kind, 'not-sent', JSON.stringify(result))
    assert.equal('reason' in result && result.reason, reason)
    assert.deepEqual(remote.control.gcodeScripts, [])
  }
  return { remote, run, notSent }
}

for (const [name, options, args] of [
  ['a jog on an unhomed axis', { homedAxes: '' }, jog],
  ['a jog past the axis limit', {}, { ...jog, distance_mm: -100 }],
] as const) {
  test(`generic Moonraker: ${name} is not sent and blocks nothing`, async (t) => {
    const { notSent } = await world(t, options)
    await notSent('jog', args, 'state')
    // The same refusal again, not `busy`: the first one left no lock.
    await notSent('jog', args, 'state')
  })
}

test('generic Moonraker: a builder refusal is not sent and blocks nothing', async (t) => {
  const { notSent } = await world(t)
  const args = { heater: 'chamber', target_c: 40 }
  await notSent('set_temperature', args, 'unsupported-action')
  await notSent('set_temperature', args, 'unsupported-action')
})

test('API command: a generic Moonraker validation refusal is journalled not-sent', async (t) => {
  const remote = await startMoonrakerMock({ profile: 'sv06' })
  t.after(() => remote.close())
  const issuer = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const directory = mkdtempSync(join(tmpdir(), 'rv884-'))
  const journal = openCommandJournal({ directory, clock: Date.now })
  t.after(() => {
    closeCommandJournal(journal)
    rmSync(directory, { recursive: true })
  })
  const farm = randomUUID(),
    agent = randomUUID(),
    assignment = randomUUID(),
    app = randomUUID(),
    grant = randomUUID()
  const binding = createPrinterBindingRegistry({
    allowedOrigins: [remote.origin],
  }).provision({
    assignment_id: assignment,
    farm_id: farm,
    agent_id: agent,
    printer_key: 'synthetic',
    moonraker_origin: remote.origin,
  })
  const clock = {
    wallNow: Date.now,
    monotonicNow: () => performance.now(),
  }
  const router = createPauseDriverRouter({
    allowedOrigins: [remote.origin],
    limits,
    clock,
    observe: () => true,
  })
  await router.detect(binding)
  const authority = createOfflineAuthority()
  authority.confirm({ wall: Date.now(), mono: performance.now() }, 1)
  const runner = createApiCommandRunner({
    farmId: farm,
    agentId: agent,
    keys: { issuer: () => issuer.publicKey },
    grants: {
      lookup: () => ({
        grant_id: grant,
        app_id: app,
        farm_id: farm,
        scopes: [scopeForApiCommand('set_temperature')],
        revoked: false,
      }),
      freshness: authority.freshness,
    },
    journal,
    printer: () => binding,
    observe: () => ({ ready: true, printState: 'idle' }),
    driver: router,
    report: () => {},
    clock,
  })
  const cmdId = randomUUID()
  const issuedAt = Date.now()
  const result = await runner.run(
    encodeApiEnvelopeFrame({
      v: 1,
      t: 'api-envelope.command',
      envelope: await signApiEnvelope(
        {
          v: 1,
          purpose: 'api-envelope',
          issuer: API_ENVELOPE_ISSUER,
          kid: 'test',
          app_id: app,
          grant_id: grant,
          farm_id: farm,
          agent_id: agent,
          assignment_id: assignment,
          resource_id: randomUUID(),
          cmd_id: cmdId,
          nonce: newApiEnvelopeNonce(),
          issued_at: issuedAt,
          expires_at: issuedAt + 60000,
          kind: 'action',
          action: {
            action: 'set_temperature',
            args: { heater: 'chamber', target_c: 40 },
          },
        },
        issuer.privateKey,
      ),
    }),
  )
  assert.deepEqual(result, {
    kind: 'refused',
    code: 'unsupported',
    detail: 'unsupported-action',
  })
  assert.equal(readCommandOutcome(journal, cmdId)?.status, 'not-sent')
  assert.deepEqual(remote.control.gcodeScripts, [])
})

test('every builder failure is a typed refusal', () => {
  const objects = ['webhooks', 'print_stats', 'extruder', 'heater_bed', 'fan']
  const cases: [string, Record<string, unknown>, string, string[]?][] = [
    ['pause', { extra: 1 }, 'invalid-command'],
    ['home', { axes: ['e'] }, 'invalid-command'],
    ['set_speed', {}, 'invalid-command'],
    ['set_temperature', { heater: 'bed', target_c: 500 }, 'invalid-command'],
    ['set_fan', { fan: 'part', percent: 101 }, 'invalid-command'],
    ['set_light', { brightness: 101 }, 'invalid-command'],
    ['set_light', { on: true }, 'unsupported-action'],
    ['service', { op: 'klipper_restart' }, 'unsupported-action', []],
    ['run_macro', { name: 'MISSING' }, 'unsupported-action'],
    ['queue_op', { op: 'start' }, 'unsupported-action'],
    ['timelapse', { op: 'render' }, 'unsupported-action'],
    ['power', { device: 'x', on: true }, 'unsupported-action'],
    ['start_print', { file: 'a.gcode' }, 'unsupported-action'],
    // Schema errors from the argument parsers are typed too.
    ['start_print', { file: '../a' }, 'invalid-command'],
    ['jog', {}, 'invalid-command'],
    ['unknown', {}, 'unsupported-action'],
    ['emergency_stop', {}, 'unsupported-action', [SNAPMAKER_U1_MARKER]],
  ]
  for (const [action, args, refusal, listed] of cases)
    assert.throws(
      () => buildMoonrakerCommand(action, args, listed ?? objects),
      (error) =>
        error instanceof DriverRefusalError && error.refusal === refusal,
      `${action} ${JSON.stringify(args)}`,
    )
})

const { WebSocketServer } = createRequire(
  new URL('../../packages/connector/package.json', import.meta.url),
)('ws') as typeof import('ws')

for (const action of ['jog', 'config_write'] as const) {
  test(`a failed read before the ${action} write is a refusal`, async (t) => {
    // Answers the preparation query, then drops the connection.
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    t.after(() => server.close())
    await once(server, 'listening')
    const methods: number[] = []
    server.on('connection', (socket) =>
      socket.on('message', (data) => {
        const { id } = JSON.parse(String(data)) as { id: number }
        methods.push(id)
        if (id !== 1) return socket.terminate()
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: {
              eventtime: 1,
              status: {
                webhooks: { state: 'ready' },
                print_stats: { state: 'standby' },
              },
            },
          }),
        )
      }),
    )
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const binding = createPrinterBindingRegistry({
      allowedOrigins: [origin],
    }).provision({
      assignment_id: randomUUID(),
      farm_id: randomUUID(),
      agent_id: randomUUID(),
      printer_key: 'synthetic',
      moonraker_origin: origin,
    })
    const owner = new AbortController()
    const attempt = openFixedMoonrakerPause({
      binding,
      allowedOrigins: [origin],
      limits,
      connectionGeneration: 1,
      clock: { monotonicNow: () => performance.now() },
      publish() {},
      signal: owner.signal,
      objects: ['webhooks', 'print_stats', 'toolhead', 'configfile'],
    })
    t.after(() => attempt.close())
    await attempt.prepare()
    let guarded = false
    // The configuration editor reads over HTTP, which this server refuses.
    await assert.rejects(
      async () =>
        attempt.driver.execute!(
          action,
          action === 'jog'
            ? jog
            : {
                path: 'printer.cfg',
                base_sha256: 'a'.repeat(64),
                backup: 'printer.cfg.openfarm-1700000000000.bak',
              },
          {
            binding,
            transportId: randomUUID(),
            stillAuthorized: () => true,
            beforeSend() {
              guarded = true
              return true
            },
            signal: owner.signal,
          },
        ),
      (error) =>
        error instanceof DriverRefusalError && error.refusal === 'state',
    )
    assert.equal(guarded, false)
    assert.ok(!methods.includes(2))
  })
}
