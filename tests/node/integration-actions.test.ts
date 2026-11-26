import assert from 'node:assert/strict'
import test from 'node:test'
import type { ApiEnvelopeAction } from '../../packages/farm-protocol/src/api-envelope.ts'
import type {
  EnvelopeRecord,
  IssueEnvelope,
  IssueResult,
} from '../../apps/farm/server/services/integration-delivery.ts'
import type { IntegrationGrant } from '../../apps/farm/server/services/integration-apps.ts'
import type { IntegrationPrincipal } from '../../apps/farm/server/utils/integration-auth.ts'
import {
  actionRequestHash,
  IntegrationActionsService,
  parseActionRequest,
  type ActionRecord,
  type CreateActionOutcome,
  type IntegrationActionsStore,
  type NewAction,
} from '../../apps/farm/server/services/integration-actions.ts'
import {
  getIntegrationActionRequest,
  submitIntegrationActionRequest,
} from '../../apps/farm/server/utils/integration-actions-http.ts'

const farmId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const printerId = 'aaaaaaaa-0000-4000-8000-000000000001'
const appId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const grantId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const actionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

function grant(scopes: IntegrationGrant['scopes']): IntegrationGrant {
  return {
    id: grantId,
    appId,
    farmId,
    printerAssignmentId: printerId,
    scopes,
    requiresApproval: false,
    createdAt: 1,
    disabledAt: null,
    disabledReason: null,
  }
}
function principal(scopes: IntegrationGrant['scopes']): IntegrationPrincipal {
  return { appId, scopes, grants: [grant(scopes)] }
}
function record(
  action: ApiEnvelopeAction,
  overrides: Partial<ActionRecord> = {},
): ActionRecord {
  return {
    id: actionId,
    appId,
    grantId,
    farmId,
    printerAssignmentId: printerId,
    idempotencyKey: 'request-1',
    requestHash: actionRequestHash(printerId, action),
    action,
    requiredScope: ['pause', 'resume', 'cancel'].includes(action.action)
      ? 'control:basic'
      : 'control:extended',
    status: 'submitted',
    createdAt: 10,
    updatedAt: 10,
    ...overrides,
  }
}
function envelope(action: ActionRecord): EnvelopeRecord {
  return {
    cmdId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    appId,
    grantId,
    farmId,
    agentId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    printerAssignmentId: printerId,
    kind: 'action',
    resourceId: action.id,
    requiredScope: action.requiredScope,
    nonce: 'a'.repeat(22),
    wire: 'signed',
    issuedAt: 10,
    expiresAt: 20,
    status: 'completed',
    refusalCode: null,
    resultDetail: null,
    historyEntryId: null,
    createdAt: 10,
    updatedAt: 20,
  }
}

function fixture(
  controls: readonly string[] | null = [
    'pause',
    'resume',
    'cancel',
    'set_temperature',
  ],
) {
  const saved: NewAction[] = []
  const issued: IssueEnvelope[] = []
  const stored: ActionRecord[] = []
  let currentEnvelope: EnvelopeRecord | null = null
  let existing: ActionRecord | null = null
  const store: IntegrationActionsStore = {
    async target() {
      return {
        farmId,
        agentId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        controls,
      }
    },
    async existing() {
      return existing ? { record: existing, envelope: currentEnvelope } : null
    },
    async create(input): Promise<CreateActionOutcome> {
      saved.push(input)
      if (existing)
        return {
          kind: 'existing',
          record: existing,
          cmdId: currentEnvelope?.cmdId ?? null,
        }
      const created = record(input.action, input)
      stored.push(created)
      return { kind: 'created', record: created }
    },
    async get() {
      return stored[0] ? { record: stored[0], envelope: currentEnvelope } : null
    },
  }
  const service = new IntegrationActionsService({
    store,
    envelopes: {
      async issue(input): Promise<IssueResult> {
        issued.push(input)
        currentEnvelope = envelope(stored[0]!)
        return { ok: true, record: currentEnvelope, created: true }
      },
      async deliver() {
        return 'sent'
      },
      async get() {
        return currentEnvelope
      },
    },
    now: () => 10,
  })
  return {
    service,
    saved,
    issued,
    stored,
    setExisting(action: ActionRecord) {
      existing = action
      stored.push(action)
    },
    get currentEnvelope() {
      return currentEnvelope
    },
  }
}

test('validates API action arguments and translates temperatures to the envelope contract', () => {
  assert.deepEqual(parseActionRequest({ action: 'pause', args: {} }), {
    action: 'pause',
    args: {},
  })
  assert.deepEqual(
    parseActionRequest({
      action: 'set_temperature',
      args: { heater: 'extruder', targetCelsius: 210 },
    }),
    {
      action: 'set_temperature',
      args: { heater: 'extruder', target_c: 210 },
    },
  )
  assert.equal(
    parseActionRequest({
      action: 'set_temperature',
      args: { heater: 'extruder', targetCelsius: -1 },
    }),
    null,
  )
  assert.deepEqual(parseActionRequest({ action: 'emergency_stop', args: {} }), {
    action: 'emergency_stop',
    args: {},
  })
  assert.equal(
    parseActionRequest({ action: 'emergency_stop', args: { extra: 1 } }),
    null,
  )
})

test('unsupported advertised controls do not create a resource or issue an envelope', async () => {
  const f = fixture(['pause'])
  const result = await f.service.submit(
    principal(['control:basic']),
    printerId,
    'request-1',
    { action: 'resume', args: {} },
  )
  assert.deepEqual(result, { ok: false, problem: 'unsupported' })
  assert.equal(f.saved.length, 0)
  assert.equal(f.issued.length, 0)
})

test('API emergency stop requires its grant and an advertised control', async () => {
  const request = { action: 'emergency_stop', args: {} }
  const advertised = fixture(['emergency_stop'])
  assert.deepEqual(
    await advertised.service.submit(
      principal(['control:basic']),
      printerId,
      'stop-no-scope',
      request,
    ),
    { ok: false, problem: 'insufficient-scope' },
  )
  assert.deepEqual(
    await advertised.service.submit(
      principal(['control:extended']),
      printerId,
      'stop-extended-only',
      request,
    ),
    { ok: false, problem: 'insufficient-scope' },
  )
  assert.equal(advertised.issued.length, 0)
  assert.equal(
    (
      await advertised.service.submit(
        principal(['control:emergency']),
        printerId,
        'stop-emergency',
        request,
      )
    ).ok,
    true,
  )
  assert.equal(advertised.issued.length, 1)
  const missing = fixture(null)
  assert.deepEqual(
    await missing.service.submit(
      principal(['control:emergency']),
      printerId,
      'stop-no-list',
      request,
    ),
    { ok: false, problem: 'unsupported' },
  )
  assert.equal(missing.issued.length, 0)
})

test('unknown capabilities defer basic actions to the Connector but reject extended actions', async () => {
  const basic = fixture(null)
  assert.equal(
    (
      await basic.service.submit(
        principal(['control:basic']),
        printerId,
        'cancel',
        { action: 'cancel', args: {} },
      )
    ).ok,
    true,
  )
  const extended = fixture(null)
  assert.deepEqual(
    await extended.service.submit(
      principal(['control:extended']),
      printerId,
      'home',
      { action: 'home', args: { axes: ['x'] } },
    ),
    { ok: false, problem: 'unsupported' },
  )
})

test('scope is checked per action and supported basic actions use a signed envelope', async () => {
  const f = fixture()
  const denied = await f.service.submit(
    principal(['control:basic']),
    printerId,
    'request-1',
    {
      action: 'set_temperature',
      args: { heater: 'extruder', targetCelsius: 200 },
    },
  )
  assert.deepEqual(denied, { ok: false, problem: 'insufficient-scope' })
  assert.equal(f.saved.length, 0)

  const accepted = await f.service.submit(
    principal(['control:basic']),
    printerId,
    'request-1',
    { action: 'pause', args: {} },
  )
  assert.equal(accepted.ok, true)
  if (!accepted.ok) return
  assert.equal(accepted.action.status, 'completed')
  assert.equal(f.issued.length, 1)
  assert.equal(f.issued[0]?.command.kind, 'action')
  assert.equal(
    f.issued[0]?.command.kind === 'action' && f.issued[0].command.action.action,
    'pause',
  )
})

test('extended controls require extended scope and response preserves API argument names', async () => {
  const f = fixture()
  const result = await f.service.submit(
    principal(['control:extended']),
    printerId,
    'request-1',
    { action: 'set_temperature', args: { heater: 'bed', targetCelsius: 60 } },
  )
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.action.status, 'completed')
  assert.deepEqual(result.action.args, { heater: 'bed', targetCelsius: 60 })
  assert.deepEqual(
    f.issued[0]?.command.kind === 'action'
      ? f.issued[0].command.action.args
      : null,
    { heater: 'bed', target_c: 60 },
  )
})

test('idempotency replays the existing action and rejects a changed body', async () => {
  const f = fixture()
  const request = { action: 'pause', args: {} }
  const first = await f.service.submit(
    principal(['control:basic']),
    printerId,
    'request-1',
    request,
  )
  assert.equal(first.ok, true)
  assert.equal(f.issued.length, 1)
  if (!first.ok) return
  f.setExisting(f.stored[0]!)
  const replay = await f.service.submit(
    principal(['control:basic']),
    printerId,
    'request-1',
    request,
  )
  assert.equal(replay.ok && replay.created, false)
  assert.equal(f.issued.length, 1)
  const reused = await f.service.submit(
    principal(['control:extended']),
    printerId,
    'request-1',
    {
      action: 'set_temperature',
      args: { heater: 'bed', targetCelsius: 60 },
    },
  )
  assert.deepEqual(reused, { ok: false, problem: 'idempotency-key-reused' })
})

test('approval grants hold actions without envelope delivery', async () => {
  const heldGrant = { ...grant(['control:basic']), requiresApproval: true }
  const heldStore: IntegrationActionsStore = {
    async target() {
      return {
        farmId,
        agentId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        controls: ['pause'],
      }
    },
    async existing() {
      return null
    },
    async create(input) {
      return {
        kind: 'created',
        record: record(input.action, { ...input, status: 'held' }),
      }
    },
    async get() {
      return null
    },
  }
  const f = fixture(['pause'])
  const heldService = new IntegrationActionsService({
    store: heldStore,
    envelopes: {
      issue: async () => {
        throw new Error('must not issue')
      },
      deliver: async () => 'sent',
      get: async () => null,
    },
  })
  const result = await heldService.submit(
    { ...principal(['control:basic']), grants: [heldGrant] },
    printerId,
    'request-1',
    { action: 'pause', args: {} },
  )
  assert.equal(result.ok && result.action.status, 'held')
  assert.equal(f.issued.length, 0)
})

test('action result retrieval reports E7.16 Connector outcome', async () => {
  const f = fixture()
  await f.service.submit(principal(['control:basic']), printerId, 'request-1', {
    action: 'pause',
    args: {},
  })
  const response = await getIntegrationActionRequest(
    principal(['control:basic']),
    actionId,
    f.service,
  )
  assert.equal(response.status, 200)
  const body = (await response.json()) as { status: string }
  assert.equal(body.status, 'completed')
})

test('HTTP action submission requires JSON and Idempotency-Key and returns a 202 resource', async () => {
  const f = fixture()
  const request = new Request(
    'http://localhost/api/integrations/v1/printers/' + printerId + '/actions',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'request-1',
      },
      body: JSON.stringify({ action: 'pause', args: {} }),
    },
  )
  const response = await submitIntegrationActionRequest(
    request,
    principal(['control:basic']),
    printerId,
    f.service,
  )
  assert.equal(response.status, 202)
  const body = (await response.json()) as {
    id: string
    action: string
    status: string
  }
  assert.equal(
    response.headers.get('location'),
    `/api/integrations/v1/actions/${body.id}`,
  )
  assert.deepEqual(body, {
    id: body.id,
    farmId,
    printerId,
    action: 'pause',
    args: {},
    status: 'completed',
    createdAt: 10,
    updatedAt: 20,
  })
})
