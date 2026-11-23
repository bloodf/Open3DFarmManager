// Environment controls (#693) on the server: readiness, management links,
// grant scoping, app isolation and the one-envelope, no-retry action flow.
// In-memory fakes only; nothing reaches a Connector or a printer.
import { describe, expect, it, vi } from 'vitest'
import type { IntegrationGrant } from '../../apps/farm/server/services/integration-apps.ts'
import type {
  IntegrationPrincipal,
  IntegrationPrinterRow,
} from '../../apps/farm/server/utils/integration-auth.ts'
import {
  environmentActionView,
  environmentControlsForPrinter,
  getEnvironmentControlAction,
  listIntegrationEnvironmentControls,
  parseEnvironmentControlRequest,
  submitEnvironmentControlAction,
  type EnvironmentControlEnvelope,
  type EnvironmentControlPorts,
  type EnvironmentControlRecord,
} from '../../apps/farm/server/utils/integration-environment-controls.ts'

const NOW = 1_800_000_000_000
const farmA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const farmB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const printerA1 = 'aaaaaaaa-0000-4000-8000-000000000001'
const printerA2 = 'aaaaaaaa-0000-4000-8000-000000000002'
const printerB1 = 'bbbbbbbb-0000-4000-8000-000000000001'
const agent = 'cccccccc-0000-4000-8000-000000000001'

function row(
  id: string,
  farmId: string,
  state: Record<string, unknown> | null = {},
): IntegrationPrinterRow {
  return {
    id,
    farmId,
    agentId: agent,
    printerKey: `key ${id.slice(-1)}`,
    displayName: 'Alpha',
    location: 'Sala 1',
    sandbox: true,
    state:
      state === null
        ? null
        : {
            printerKey: 'k',
            state: 'idle',
            progress: 0,
            observedAt: NOW - 1000,
            controls: ['pause', 'resume', 'cancel', 'set_fan'],
            fans: { chamber: 30 },
            ...state,
          },
    observedAt: NOW - 1000,
  }
}

function principal(
  grants: Partial<IntegrationGrant>[],
  appId = 'app-1',
): IntegrationPrincipal {
  const full = grants.map((grant, index): IntegrationGrant => ({
    id: `grant-${index}`,
    appId,
    farmId: farmA,
    printerAssignmentId: null,
    scopes: ['environment:control'],
    requiresApproval: false,
    createdAt: 1,
    disabledAt: null,
    disabledReason: null,
    ...grant,
  }))
  return {
    appId,
    scopes: [...new Set(full.flatMap((grant) => grant.scopes))],
    grants: full,
  }
}

function memoryPorts(
  deliver: (envelope: EnvironmentControlEnvelope) => void = (envelope) => {
    envelope.status = 'delivered'
  },
) {
  const records: EnvironmentControlRecord[] = []
  const envelopes = new Map<string, EnvironmentControlEnvelope>()
  const byResource = new Map<string, string>()
  const envelopeOf = (id: string) =>
    envelopes.get(byResource.get(id) ?? '') ?? null
  const issued: unknown[] = []
  const ports: EnvironmentControlPorts = {
    store: {
      async existing(appId, key) {
        const record = records.find(
          (entry) => entry.appId === appId && entry.idempotencyKey === key,
        )
        return record ? { record, envelope: envelopeOf(record.id) } : null
      },
      async create(record) {
        records.push(record)
        return { kind: 'created', record }
      },
      async get(id, appId) {
        const record = records.find(
          (entry) => entry.id === id && entry.appId === appId,
        )
        return record ? { record, envelope: envelopeOf(record.id) } : null
      },
    },
    envelopes: {
      async issue(input) {
        issued.push(input)
        const envelope: EnvironmentControlEnvelope = {
          cmdId: `cmd-${issued.length}`,
          status: 'pending',
          refusalCode: null,
          resultDetail: null,
          updatedAt: NOW,
        }
        envelopes.set(envelope.cmdId, envelope)
        byResource.set(input.resourceId, envelope.cmdId)
        return { ok: true, created: true, envelope }
      },
      deliver: vi.fn(async (cmdId: string) => {
        deliver(envelopes.get(cmdId)!)
      }),
      async get(cmdId) {
        return envelopes.get(cmdId) ?? null
      },
    },
  }
  return { ports, records, issued, envelopes }
}

const extraction = {
  control: 'extraction',
  action: 'set',
  args: { percent: 70 },
}

function deps(
  rows: IntegrationPrinterRow[],
  ports: EnvironmentControlPorts | null,
) {
  return {
    readPrinter: async (id: string) =>
      rows.find((entry) => entry.id === id) ?? null,
    ports,
    now: () => NOW,
  }
}

describe('readiness and management links', () => {
  const control = principal([{}])
  const kinds = (
    target: IntegrationPrinterRow,
    who = control,
  ): Record<
    string,
    ReturnType<typeof environmentControlsForPrinter>['controls'][number]
  > =>
    Object.fromEntries(
      environmentControlsForPrinter(who, target, NOW).controls.map((entry) => [
        entry.kind,
        entry,
      ]),
    )

  it('qualifies extraction from the reported chamber fan only', () => {
    const view = kinds(row(printerA1, farmA))
    expect(view.extraction).toEqual({
      kind: 'extraction',
      readiness: 'ready',
      observed: {
        kind: 'air',
        state: 'known',
        value: 30,
        unit: 'percent',
        lastObservedAt: NOW - 1000,
      },
      actions: ['set'],
      managementUrl: `/impressoras/key%201?farm=${farmA}`,
    })
    for (const kind of ['plug', 'drying'])
      expect(view[kind]).toMatchObject({
        readiness: 'unsupported',
        reason: 'no-qualified-capability',
        actions: [],
        managementUrl: `/impressoras/key%201?farm=${farmA}`,
      })
    expect(view.plug!.observed).toEqual({ kind: 'power', state: 'unsupported' })
    expect(view.drying!.observed).toBeUndefined()
  })

  it('reports stale, offline, never-observed, failed and unsupported devices', () => {
    expect(
      kinds(row(printerA1, farmA, { observedAt: NOW - 61_000 })).extraction,
    ).toMatchObject({
      readiness: 'stale',
      reason: 'stale',
      observed: { state: 'unknown', reason: 'stale' },
    })
    expect(
      kinds(
        row(printerA1, farmA, {
          state: 'offline',
          progress: undefined,
        }),
      ).extraction,
    ).toMatchObject({ readiness: 'not-ready', reason: 'offline' })
    expect(kinds(row(printerA1, farmA, null)).extraction).toMatchObject({
      readiness: 'not-ready',
      reason: 'never-observed',
    })
    expect(
      kinds(row(printerA1, farmA, { state: 'error' })).extraction,
    ).toMatchObject({ readiness: 'not-ready', reason: 'printer-error' })
    expect(
      kinds(row(printerA1, farmA, { fans: undefined })).extraction,
    ).toMatchObject({
      readiness: 'unsupported',
      reason: 'no-qualified-capability',
      actions: [],
    })
    expect(
      kinds(row(printerA1, farmA, { controls: ['pause'] })).extraction,
    ).toMatchObject({ readiness: 'unsupported', actions: [] })
  })

  it('offers no actions without environment:control', () => {
    const reader = principal([{ scopes: ['environment:read'] }])
    expect(kinds(row(printerA1, farmA), reader).extraction!.actions).toEqual([])
  })

  it('lists only granted printers for either environment scope', async () => {
    const rows = [row(printerA1, farmA), row(printerA2, farmA)]
    const readPrinters = vi.fn(async () => rows)
    const scoped = principal([
      { scopes: ['environment:control'], printerAssignmentId: printerA2 },
    ])
    const page = await listIntegrationEnvironmentControls(
      scoped,
      { readPrinters },
      new URLSearchParams(),
      NOW,
    )
    expect('data' in page && page.data.map((entry) => entry.printerId)).toEqual(
      [printerA2],
    )
    expect(readPrinters).toHaveBeenCalledWith(
      expect.objectContaining({
        farmWideFarmIds: [],
        assignmentIds: [printerA2],
      }),
    )
    expect(
      await listIntegrationEnvironmentControls(
        scoped,
        { readPrinters },
        new URLSearchParams({ farmId: farmB }),
        NOW,
      ),
    ).toEqual({ error: 'not-found' })
    expect(
      await listIntegrationEnvironmentControls(
        principal([{ scopes: ['printers:read'] }]),
        { readPrinters },
        new URLSearchParams(),
        NOW,
      ),
    ).toEqual({ error: 'not-found' })
  })
})

describe('request parsing', () => {
  it('maps each documented request to one signed environment action', () => {
    expect(parseEnvironmentControlRequest(extraction)?.action).toEqual({
      action: 'extraction_set',
      args: { percent: 70 },
    })
    expect(
      parseEnvironmentControlRequest({
        control: 'plug',
        action: 'off',
        args: { device: 'dryer' },
      })?.action,
    ).toEqual({ action: 'plug_switch', args: { device: 'dryer', on: false } })
    expect(
      parseEnvironmentControlRequest({
        control: 'drying',
        action: 'stop',
        args: {},
      })?.action,
    ).toEqual({ action: 'drying_stop', args: {} })
  })

  it('rejects unknown fields, actions and values', () => {
    for (const body of [
      null,
      [],
      { ...extraction, extra: 1 },
      { control: 'extraction', action: 'on', args: {} },
      { control: 'extraction', action: 'set', args: { percent: 1.5 } },
      { control: 'plug', action: 'on', args: { device: 'x', on: false } },
      { control: 'plug', action: 'on', args: { device: '' } },
      { control: 'drying', action: 'stop', args: { now: true } },
      { control: 'power', action: 'off', args: {} },
    ])
      expect(parseEnvironmentControlRequest(body)).toBeNull()
  })
})

describe('submitting an environment control', () => {
  const rows = [row(printerA1, farmA), row(printerB1, farmB)]

  it('issues exactly one environment:control envelope and reports its delivery', async () => {
    const memory = memoryPorts()
    const result = await submitEnvironmentControlAction(
      principal([{}]),
      printerA1.toUpperCase(),
      'key-1',
      extraction,
      deps(rows, memory.ports),
    )
    expect(result).toMatchObject({
      ok: true,
      created: true,
      action: {
        printerId: printerA1,
        farmId: farmA,
        control: 'extraction',
        action: 'set',
        args: { percent: 70 },
        status: 'delivered',
        outcome: 'pending',
        managementUrl: `/impressoras/key%201?farm=${farmA}`,
      },
    })
    expect(memory.issued).toEqual([
      expect.objectContaining({
        agentId: agent,
        farmId: farmA,
        printerAssignmentId: printerA1,
        grantId: 'grant-0',
        action: { action: 'extraction_set', args: { percent: 70 } },
      }),
    ])
    expect(memory.ports.envelopes.deliver).toHaveBeenCalledTimes(1)
  })

  it('never retries an uncertain delivery', async () => {
    const memory = memoryPorts(() => {
      throw new Error('socket closed mid-write')
    })
    const result = await submitEnvironmentControlAction(
      principal([{}]),
      printerA1,
      'key-1',
      extraction,
      deps(rows, memory.ports),
    )
    expect(result).toMatchObject({
      ok: true,
      action: { status: 'queued', outcome: 'pending' },
    })
    expect(memory.ports.envelopes.deliver).toHaveBeenCalledTimes(1)
    // A replay returns the stored action and sends nothing new.
    const replay = await submitEnvironmentControlAction(
      principal([{}]),
      printerA1,
      'key-1',
      extraction,
      deps(rows, memory.ports),
    )
    expect(replay).toMatchObject({ ok: true, created: false })
    expect(memory.issued).toHaveLength(1)
    expect(memory.ports.envelopes.deliver).toHaveBeenCalledTimes(1)
  })

  it('refuses a reused key with another body', async () => {
    const memory = memoryPorts()
    const who = principal([{}])
    await submitEnvironmentControlAction(
      who,
      printerA1,
      'k',
      extraction,
      deps(rows, memory.ports),
    )
    expect(
      await submitEnvironmentControlAction(
        who,
        printerA1,
        'k',
        { ...extraction, args: { percent: 10 } },
        deps(rows, memory.ports),
      ),
    ).toEqual({ ok: false, problem: 'idempotency-key-reused' })
  })

  it('answers out-of-grant printers as not found', async () => {
    const memory = memoryPorts()
    for (const [who, target] of [
      [principal([{}]), printerB1],
      [principal([{ printerAssignmentId: printerA2 }]), printerA1],
      [principal([{ scopes: ['environment:read'] }]), printerA1],
      [principal([{}]), 'not-a-uuid'],
      [principal([{}]), 'aaaaaaaa-0000-4000-8000-00000000ffff'],
    ] as const) {
      const result = await submitEnvironmentControlAction(
        who,
        target,
        'k',
        extraction,
        deps(rows, memory.ports),
      )
      expect(result.ok).toBe(false)
      if (!result.ok)
        expect(['not-found', 'insufficient-scope']).toContain(result.problem)
    }
    expect(memory.issued).toEqual([])
  })

  it('answers unsupported devices with the OpenFarm management link', async () => {
    const memory = memoryPorts()
    for (const body of [
      { control: 'plug', action: 'on', args: { device: 'dryer' } },
      {
        control: 'drying',
        action: 'start',
        args: { targetCelsius: 50, durationMinutes: 120 },
      },
    ])
      expect(
        await submitEnvironmentControlAction(
          principal([{}]),
          printerA1,
          'k',
          body,
          deps(rows, memory.ports),
        ),
      ).toEqual({
        ok: false,
        problem: 'unsupported',
        managementUrl: `/impressoras/key%201?farm=${farmA}`,
      })
    expect(
      await submitEnvironmentControlAction(
        principal([{ requiresApproval: true }]),
        printerA1,
        'k',
        extraction,
        deps(rows, memory.ports),
      ),
    ).toMatchObject({ ok: false, problem: 'unsupported' })
    expect(memory.issued).toEqual([])
  })

  it('refuses stale and not-ready devices without a command', async () => {
    const memory = memoryPorts()
    const submit = (target: IntegrationPrinterRow) =>
      submitEnvironmentControlAction(
        principal([{}]),
        printerA1,
        'k',
        extraction,
        deps([target], memory.ports),
      )
    expect(
      await submit(row(printerA1, farmA, { observedAt: NOW - 120_000 })),
    ).toMatchObject({ ok: false, problem: 'device-stale' })
    expect(await submit(row(printerA1, farmA, null))).toMatchObject({
      ok: false,
      problem: 'device-not-ready',
    })
    expect(
      await submit(
        (({ agentId: _agentId, ...rest }) => rest)(row(printerA1, farmA)),
      ),
    ).toMatchObject({ ok: false, problem: 'device-not-ready' })
    expect(memory.issued).toEqual([])
  })

  it('sends nothing while action storage is not configured', async () => {
    expect(
      await submitEnvironmentControlAction(
        principal([{}]),
        printerA1,
        'k',
        extraction,
        deps(rows, null),
      ),
    ).toEqual({ ok: false, problem: 'service-unavailable' })
  })
})

describe('reading the real outcome', () => {
  async function seeded(outcome: Partial<EnvironmentControlEnvelope>) {
    const memory = memoryPorts((envelope) => Object.assign(envelope, outcome))
    const result = await submitEnvironmentControlAction(
      principal([{}]),
      printerA1,
      'k',
      extraction,
      deps([row(printerA1, farmA)], memory.ports),
    )
    if (!result.ok) throw new Error(result.problem)
    return { memory, id: result.action.id }
  }

  it('reports accepted, refused, unsupported, failed and unknown outcomes', async () => {
    for (const [envelope, expected] of [
      [{ status: 'completed' }, { status: 'completed', outcome: 'accepted' }],
      [
        {
          status: 'refused',
          refusalCode: 'printer-busy',
          resultDetail: 'extraction-interlock-print-active',
        },
        {
          status: 'refused',
          outcome: 'refused',
          refusal: {
            code: 'printer-busy',
            detail: 'extraction-interlock-print-active',
          },
        },
      ],
      [
        { status: 'refused', refusalCode: 'unsupported' },
        { status: 'refused', outcome: 'unsupported' },
      ],
      [{ status: 'failed' }, { status: 'failed', outcome: 'failed' }],
      [{ status: 'expired' }, { status: 'expired', outcome: 'not-delivered' }],
      [
        { status: 'outcome-unknown' },
        { status: 'outcome-unknown', outcome: 'unknown' },
      ],
    ] as const) {
      const { memory, id } = await seeded(envelope as never)
      expect(
        await getEnvironmentControlAction(
          principal([{}]),
          printerA1,
          id,
          memory.ports,
        ),
      ).toMatchObject(expected)
    }
  })

  it('isolates apps, printers and revoked grants', async () => {
    const { memory, id } = await seeded({ status: 'completed' })
    expect(
      await getEnvironmentControlAction(
        principal([{}], 'app-2'),
        printerA1,
        id,
        memory.ports,
      ),
    ).toEqual({ error: 'not-found' })
    expect(
      await getEnvironmentControlAction(
        principal([{}]),
        printerA2,
        id,
        memory.ports,
      ),
    ).toEqual({ error: 'not-found' })
    expect(
      await getEnvironmentControlAction(
        principal([{ printerAssignmentId: printerA2 }]),
        printerA1,
        id,
        memory.ports,
      ),
    ).toEqual({ error: 'not-found' })
    expect(
      await getEnvironmentControlAction(principal([{}]), printerA1, id, null),
    ).toEqual({ error: 'service-unavailable' })
  })

  it('never reports a refusal for a result that was not refused', () => {
    const record = {
      id: 'x',
      appId: 'a',
      grantId: 'g',
      farmId: farmA,
      printerAssignmentId: printerA1,
      printerKey: 'k',
      idempotencyKey: 'k',
      requestHash: 'h',
      action: { action: 'extraction_set', args: { percent: 5 } },
      createdAt: 1,
      updatedAt: 1,
    } satisfies EnvironmentControlRecord
    expect(
      environmentActionView(record, {
        cmdId: 'c',
        status: 'completed',
        refusalCode: 'unsupported',
        resultDetail: 'x',
        updatedAt: 2,
      }),
    ).not.toHaveProperty('refusal')
    expect(environmentActionView(record, null)).toMatchObject({
      status: 'queued',
      outcome: 'pending',
      updatedAt: 1,
    })
  })
})
