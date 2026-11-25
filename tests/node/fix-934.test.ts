import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { Sql } from 'postgres'
import { IntegrationActionsService } from '../../apps/farm/server/services/integration-actions.ts'
import { PostgresIntegrationActions } from '../../apps/farm/server/storage/integration-actions-postgres.ts'
import type { IntegrationPrincipal } from '../../apps/farm/server/utils/integration-auth.ts'
import { OBSERVATION_FRESH_MS } from '../../apps/farm/server/utils/integration-telemetry.ts'
import { KOBRALINK_CONTROLS } from '../../packages/connector/src/kobralink/extended-control.ts'
import type { ExtendedControlAction } from '../../packages/farm-protocol/src/control-actions.ts'
import { encodePauseCapability } from '../../packages/farm-protocol/src/pause-capability.ts'
import {
  createV2Authority,
  nodeSigner,
  openV2Dispatch,
} from '../helpers/command-v2-dispatch.ts'
import { issueBrowserCapability } from '../helpers/postgres-browser-capability.ts'

const stop = ['pause', 'cancel', 'emergency_stop'] as const
const nonStop = [
  {
    action: 'set_temperature',
    args: { heater: 'extruder', targetCelsius: 200 },
  },
  { action: 'home', args: { axes: ['x'] } },
  { action: 'run_macro', args: { name: 'PARK' } },
  { action: 'start_library_print', args: { sha256: 'a'.repeat(64) } },
] satisfies { action: ExtendedControlAction; args: object }[]
const advertised: ExtendedControlAction[] = [
  ...stop,
  ...nonStop.map(({ action }) => action),
  'start_print',
]

test('browser capabilities sign only advertised stops when controls are stale', async (t) => {
  const fixture = await createV2Authority(await nodeSigner())
  const dispatcher = await openV2Dispatch(fixture, {
    now: 2000,
    async capabilityWire(claims) {
      const fresh = await issueBrowserCapability(
        fixture,
        claims,
        advertised,
        0,
        'admin',
      )
      assert.ok(fresh.ok)
      for (const action of advertised)
        assert.ok(fresh.capability.actions.includes(action), action)
      const stale = await issueBrowserCapability(
        fixture,
        claims,
        advertised,
        OBSERVATION_FRESH_MS + 1,
        'admin',
      )
      assert.ok(stale.ok)
      assert.deepEqual(stale.capability.actions, stop)
      return encodePauseCapability(stale.capability)
    },
  })
  t.after(() => dispatcher.close())
})

function apiWithStaleControls(controls: readonly string[]) {
  const farmId = randomUUID()
  const agentId = randomUUID()
  const appId = randomUUID()
  const printerId = randomUUID()
  const observedAt = 1_000_000
  const now = observedAt + OBSERVATION_FRESH_MS + 1
  const targets = new PostgresIntegrationActions((async () => [
    {
      farmId,
      agentId,
      controls,
      observedAt,
      receivedAt: observedAt,
      ageAtSendMs: 0,
      now,
    },
  ]) as unknown as Sql)
  const principal: IntegrationPrincipal = {
    appId,
    scopes: ['control:basic', 'control:extended'],
    grants: [
      {
        id: randomUUID(),
        appId,
        farmId,
        printerAssignmentId: printerId,
        scopes: ['control:basic', 'control:extended'],
        requiresApproval: true,
        createdAt: 1,
        disabledAt: null,
        disabledReason: null,
      },
    ],
  }
  const service = new IntegrationActionsService({
    now: () => now,
    store: {
      target: (id) => targets.target(id),
      existing: async () => null,
      create: async (action, timestamp) => ({
        kind: 'created',
        record: { ...action, createdAt: timestamp, updatedAt: timestamp },
      }),
      get: async () => null,
    },
  })
  return {
    target: () => targets.target(printerId),
    submit: (body: { action: string; args: object }) =>
      service.submit(principal, printerId, `fix-934-${body.action}`, body),
  }
}

test('API target and action submission admit only advertised stops with stale controls', async () => {
  const api = apiWithStaleControls(advertised)
  assert.deepEqual((await api.target())?.controls, stop)
  for (const action of stop) {
    const result = await api.submit({ action, args: {} })
    assert.ok(result.ok, JSON.stringify(result))
    assert.equal(result.action.action, action)
  }
  for (const request of nonStop)
    assert.deepEqual(await api.submit(request), {
      ok: false,
      problem: 'unsupported',
    })
})

test('a paused KobraLink printer can accept an API cancel after 120 seconds without a new report', async () => {
  // An unchanged paused state is polled locally but does not refresh the API row.
  const api = apiWithStaleControls(KOBRALINK_CONTROLS)
  assert.deepEqual((await api.target())?.controls, ['pause', 'cancel'])
  const result = await api.submit({ action: 'cancel', args: {} })
  assert.ok(result.ok, JSON.stringify(result))
  assert.equal(result.action.action, 'cancel')
  assert.deepEqual(await api.submit({ action: 'emergency_stop', args: {} }), {
    ok: false,
    problem: 'unsupported',
  })
})
