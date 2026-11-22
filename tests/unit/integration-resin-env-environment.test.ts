import { describe, expect, it, vi } from 'vitest'
import type {
  IntegrationPrincipal,
  IntegrationPrinterRow,
} from '../../apps/farm/server/utils/integration-auth.ts'
import {
  ENVIRONMENT_STALE_AFTER_MS,
  environmentForPrinter,
  listIntegrationEnvironment,
} from '../../apps/farm/server/utils/integration-environment.ts'
import { integrationPolicy } from '../../apps/farm/server/utils/integration-auth-http.ts'
import {
  farmA,
  farmB,
  printerA1,
  printerA2,
  printerB1,
} from '../fixtures/integration-resin-env/ledger.ts'
import {
  freshChamber,
  neverObserved,
  noChamber,
  now,
  offlineChamber,
  otherFarm,
  staleChamber,
} from '../fixtures/integration-resin-env/environment.ts'

function principal(
  grants: { farmId: string; printerAssignmentId?: string; scopes?: string[] }[],
): IntegrationPrincipal {
  return {
    appId: 'app',
    scopes: ['environment:read'],
    grants: grants.map((grant, index) => ({
      id: `g${index}`,
      appId: 'app',
      farmId: grant.farmId,
      printerAssignmentId: grant.printerAssignmentId ?? null,
      scopes: (grant.scopes ?? ['environment:read']) as never,
      requiresApproval: false,
      createdAt: 0,
      disabledAt: null,
      disabledReason: null,
    })),
  }
}

const reader = (rows: IntegrationPrinterRow[]) => {
  const readPrinters = vi.fn(async (input: { limit: number }) =>
    rows.slice(0, input.limit),
  )
  return { readPrinters }
}

const measurement = (row: IntegrationPrinterRow, kind: string) =>
  environmentForPrinter(row, now).measurements.find((m) => m.kind === kind)

describe('environment measurements', () => {
  it('reports a fresh chamber fan as known with its last observed time', () => {
    expect(measurement(freshChamber, 'air')).toEqual({
      kind: 'air',
      state: 'known',
      value: 60,
      unit: 'percent',
      lastObservedAt: now - 5_000,
    })
  })

  it('reports a printer without a chamber fan as unsupported', () => {
    expect(measurement(noChamber, 'air')).toEqual({
      kind: 'air',
      state: 'unsupported',
    })
  })

  it.each(['temperature', 'humidity', 'power'])(
    'reports %s as unsupported while the Connector does not report it',
    (kind) => {
      expect(measurement(freshChamber, kind)).toEqual({
        kind,
        state: 'unsupported',
      })
    },
  )

  it('turns a stale reading into unknown and keeps the last observed time', () => {
    expect(measurement(staleChamber, 'air')).toEqual({
      kind: 'air',
      state: 'unknown',
      reason: 'stale',
      lastObservedAt: now - 600_000,
    })
    expect(JSON.stringify(measurement(staleChamber, 'air'))).not.toContain(
      'value',
    )
  })

  it('treats a reading exactly at the stale limit as current and one millisecond later as stale', () => {
    const at = (age: number) => ({
      ...freshChamber,
      state: { ...(freshChamber.state as object), observedAt: now - age },
    })
    expect(measurement(at(ENVIRONMENT_STALE_AFTER_MS), 'air')?.state).toBe(
      'known',
    )
    expect(measurement(at(ENVIRONMENT_STALE_AFTER_MS + 1), 'air')?.state).toBe(
      'unknown',
    )
  })

  it('reports unknown for a printer that never reported', () => {
    expect(measurement(neverObserved, 'air')).toEqual({
      kind: 'air',
      state: 'unknown',
      reason: 'never-observed',
    })
  })

  it('reports unknown while the printer is offline', () => {
    expect(measurement(offlineChamber, 'air')).toMatchObject({
      state: 'unknown',
      reason: 'offline',
    })
  })

  it('identifies the farm device so a storage warning can open it', () => {
    expect(environmentForPrinter(freshChamber, now)).toMatchObject({
      printerId: printerA1,
      farmId: farmA,
      printerKey: expect.any(String),
      displayName: 'Impressora 1',
      location: 'Sala de cura',
    })
  })
})

describe('environment list', () => {
  it('hides printers outside the grant even if the reader returns them', async () => {
    const result = (await listIntegrationEnvironment(
      principal([{ farmId: farmA }]),
      reader([freshChamber, noChamber, otherFarm]),
      new URLSearchParams(),
      now,
    )) as { data: { printerId: string }[] }
    expect(result.data.map((p) => p.printerId)).toEqual([printerA1, printerA2])
    expect(JSON.stringify(result)).not.toContain(printerB1)
  })

  it('limits a printer grant to its printer', async () => {
    const result = (await listIntegrationEnvironment(
      principal([{ farmId: farmA, printerAssignmentId: printerA2 }]),
      reader([freshChamber, noChamber]),
      new URLSearchParams(),
      now,
    )) as { data: { printerId: string }[] }
    expect(result.data.map((p) => p.printerId)).toEqual([printerA2])
  })

  it('requires an environment:read grant', async () => {
    const fake = reader([freshChamber])
    expect(
      await listIntegrationEnvironment(
        principal([
          { farmId: farmA, scopes: ['printers:read', 'inventory:read'] },
        ]),
        fake,
        new URLSearchParams(),
        now,
      ),
    ).toEqual({ error: 'not-found' })
    expect(fake.readPrinters).not.toHaveBeenCalled()
  })

  it('answers not-found for a farm outside the grants', async () => {
    expect(
      await listIntegrationEnvironment(
        principal([{ farmId: farmA }]),
        reader([freshChamber]),
        new URLSearchParams(`farmId=${farmB}`),
        now,
      ),
    ).toEqual({ error: 'not-found' })
  })

  it.each(['limit=0', 'limit=101', 'farmId=x', 'cursor=!!', 'extra=1'])(
    'rejects %s',
    async (query) => {
      expect(
        await listIntegrationEnvironment(
          principal([{ farmId: farmA }]),
          reader([freshChamber]),
          new URLSearchParams(query),
          now,
        ),
      ).toEqual({ error: 'invalid-request' })
    },
  )

  it('pages with an opaque cursor', async () => {
    const grants = principal([{ farmId: farmA }])
    const rows = [freshChamber, noChamber]
    const fake = {
      readPrinters: vi.fn(async (input: { limit: number; afterId?: string }) =>
        rows
          .filter((r) => !input.afterId || r.id > input.afterId)
          .slice(0, input.limit),
      ),
    }
    const first = (await listIntegrationEnvironment(
      grants,
      fake,
      new URLSearchParams('limit=1'),
      now,
    )) as {
      data: { printerId: string }[]
      nextCursor: string
    }
    expect(first.data.map((p) => p.printerId)).toEqual([printerA1])
    const second = (await listIntegrationEnvironment(
      grants,
      fake,
      new URLSearchParams(`limit=1&cursor=${first.nextCursor}`),
      now,
    )) as { data: { printerId: string }[]; nextCursor: string | null }
    expect(second.data.map((p) => p.printerId)).toEqual([printerA2])
    expect(second.nextCursor).toBeNull()
  })

  it('exposes no switching or control surface', () => {
    expect(
      integrationPolicy('/environment/measurements', 'GET')?.scopes,
    ).toEqual(['environment:read'])
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'])
      expect(
        integrationPolicy('/environment/measurements', method),
      ).toBeUndefined()
  })
})
