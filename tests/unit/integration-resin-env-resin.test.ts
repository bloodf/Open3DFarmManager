import { describe, expect, it, vi } from 'vitest'
import type { IntegrationPrincipal } from '../../apps/farm/server/utils/integration-auth.ts'
import {
  listIntegrationResinLots,
  listIntegrationResinUsage,
  listIntegrationResinVats,
  type IntegrationResinReader,
  type ResinPrinterLedger,
} from '../../apps/farm/server/utils/integration-resin.ts'
import { integrationPolicy } from '../../apps/farm/server/utils/integration-auth-http.ts'
import {
  expectedLotsA1,
  expectedVatsA1,
  farmA,
  farmB,
  printerA1,
  printerA2,
  printerA1Records,
  printerA2Records,
  printerB1,
  printerB1Records,
} from '../fixtures/integration-resin-env/ledger.ts'

const everyone: ResinPrinterLedger[] = [
  {
    printerId: printerA1,
    farmId: farmA,
    printerKey: 'a1',
    records: printerA1Records,
  },
  {
    printerId: printerA2,
    farmId: farmA,
    printerKey: 'a2',
    records: printerA2Records,
  },
  {
    printerId: printerB1,
    farmId: farmB,
    printerKey: 'b1',
    records: printerB1Records,
  },
]

function principal(
  grants: { farmId: string; printerAssignmentId?: string; scopes?: string[] }[],
): IntegrationPrincipal {
  return {
    appId: 'app',
    scopes: ['inventory:read'],
    grants: grants.map((grant, index) => ({
      id: `g${index}`,
      appId: 'app',
      farmId: grant.farmId,
      printerAssignmentId: grant.printerAssignmentId ?? null,
      scopes: (grant.scopes ?? ['inventory:read']) as never,
      requiresApproval: false,
      createdAt: 0,
      disabledAt: null,
      disabledReason: null,
    })),
  }
}

/** A reader that ignores the scope, so the util's own guard is what is tested. */
function reader(runs: { id: string; printerId: string }[] = []) {
  const readLedgers = vi.fn(
    async (input: { limit: number; afterId?: string }) =>
      everyone
        .filter(
          (printer) => !input.afterId || printer.printerId > input.afterId,
        )
        .slice(0, input.limit),
  )
  const impl: IntegrationResinReader = {
    readLedgers,
    readRuns: async () =>
      runs.map((run) => ({
        ...run,
        outcome: 'completed' as const,
        endedAt: 9_000,
      })),
  }
  return { impl, readLedgers }
}

const q = (query = '') => new URLSearchParams(query)

describe('resin lots', () => {
  it('reports manual and measured sources and keeps unknown amounts unknown', async () => {
    const result = await listIntegrationResinLots(
      principal([{ farmId: farmA }]),
      reader().impl,
      q(),
    )
    expect(result).not.toHaveProperty('error')
    const a1 = (
      result as { data: { printerId: string; lots: unknown[] }[] }
    ).data.find((printer) => printer.printerId === printerA1)
    expect(a1?.lots).toEqual(expectedLotsA1)
    expect(JSON.stringify(a1)).not.toContain('"quantity":0')
  })

  it('maps connector-reported ledger entries to measured', async () => {
    const result = (await listIntegrationResinVats(
      principal([{ farmId: farmA }]),
      reader().impl,
      q(),
    )) as { data: { printerId: string; vats: unknown[] }[] }
    expect(result.data.find((p) => p.printerId === printerA2)?.vats).toEqual([
      {
        vatRef: 'Vat-X',
        current: true,
        quantity: null,
        unit: 'ml',
        quantityState: 'unknown',
        source: 'measured',
        observedAt: 7_000,
      },
    ])
  })
})

describe('resin vats', () => {
  it('does not carry a reading taken before the vat change onto the vat', async () => {
    const result = (await listIntegrationResinVats(
      principal([{ farmId: farmA }]),
      reader().impl,
      q(),
    )) as { data: { printerId: string; vats: { quantity: number | null }[] }[] }
    expect(
      result.data.find((p) => p.printerId === printerA2)?.vats[0]?.quantity,
    ).toBeNull()
  })

  it('flags the current vat and keeps the reading of each vat', async () => {
    const result = (await listIntegrationResinVats(
      principal([{ farmId: farmA }]),
      reader().impl,
      q(),
    )) as { data: { printerId: string; vats: unknown[] }[] }
    expect(result.data.find((p) => p.printerId === printerA1)?.vats).toEqual(
      expectedVatsA1,
    )
  })
})

describe('resin usage', () => {
  it('references runs but never infers their consumption', async () => {
    const result = (await listIntegrationResinUsage(
      principal([{ farmId: farmA }]),
      reader([{ id: '42', printerId: printerA1 }]).impl,
      q(),
    )) as {
      data: { printerId: string; runs: unknown[]; readings: unknown[] }[]
    }
    const a1 = result.data.find((p) => p.printerId === printerA1)!
    expect(a1.runs).toEqual([
      {
        runRef: '42',
        outcome: 'completed',
        endedAt: 9_000,
        consumption: { state: 'unknown' },
      },
    ])
    expect(a1.readings).toEqual([
      {
        target: 'vat',
        ref: 'Vat-1',
        quantity: 410,
        unit: 'ml',
        source: 'measured',
        observedAt: 5_000,
      },
      {
        target: 'bottle',
        ref: 'Lote-A1',
        quantity: 750,
        unit: 'ml',
        source: 'manual',
        observedAt: 3_000,
      },
      {
        target: 'vat',
        ref: 'Vat-0',
        quantity: 90,
        unit: 'ml',
        source: 'manual',
        observedAt: 1_500,
      },
    ])
  })

  it('drops runs the reader returned for printers outside the page', async () => {
    const result = (await listIntegrationResinUsage(
      principal([{ farmId: farmA }]),
      reader([{ id: '7', printerId: printerB1 }]).impl,
      q(),
    )) as { data: { runs: unknown[] }[] }
    expect(result.data.every((printer) => printer.runs.length === 0)).toBe(true)
  })
})

describe('grant scoping', () => {
  it('hides printers of other farms even if the reader returns them', async () => {
    const result = (await listIntegrationResinLots(
      principal([{ farmId: farmA }]),
      reader().impl,
      q(),
    )) as { data: { printerId: string }[] }
    expect(result.data.map((p) => p.printerId)).toEqual([printerA1, printerA2])
  })

  it('limits a printer grant to its printer', async () => {
    const result = (await listIntegrationResinLots(
      principal([{ farmId: farmA, printerAssignmentId: printerA2 }]),
      reader().impl,
      q(),
    )) as { data: { printerId: string }[] }
    expect(result.data.map((p) => p.printerId)).toEqual([printerA2])
  })

  it('answers not-found without reading when no grant carries inventory:read', async () => {
    const fake = reader()
    const result = await listIntegrationResinLots(
      principal([{ farmId: farmA, scopes: ['printers:read'] }]),
      fake.impl,
      q(),
    )
    expect(result).toEqual({ error: 'not-found' })
    expect(fake.readLedgers).not.toHaveBeenCalled()
  })

  it('answers not-found for a farm outside the grants', async () => {
    const result = await listIntegrationResinLots(
      principal([{ farmId: farmA }]),
      reader().impl,
      q(`farmId=${farmB}`),
    )
    expect(result).toEqual({ error: 'not-found' })
  })

  it('does not accept environment:read as inventory access', async () => {
    const result = await listIntegrationResinVats(
      principal([{ farmId: farmA, scopes: ['environment:read'] }]),
      reader().impl,
      q(),
    )
    expect(result).toEqual({ error: 'not-found' })
  })
})

describe('query and paging', () => {
  it.each([
    'limit=0',
    'limit=101',
    'limit=abc',
    'farmId=nope',
    'cursor=!!',
    'other=1',
    `farmId=${farmA}&farmId=${farmA}`,
  ])('rejects %s', async (query) => {
    const result = await listIntegrationResinLots(
      principal([{ farmId: farmA }]),
      reader().impl,
      q(query),
    )
    expect(result).toEqual({ error: 'invalid-request' })
  })

  it('pages by printer with an opaque cursor', async () => {
    const grants = principal([{ farmId: farmA }])
    const fake = reader()
    const first = (await listIntegrationResinLots(
      grants,
      fake.impl,
      q('limit=1'),
    )) as {
      data: { printerId: string }[]
      nextCursor: string | null
    }
    expect(first.data.map((p) => p.printerId)).toEqual([printerA1])
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/)
    const second = (await listIntegrationResinLots(
      grants,
      fake.impl,
      q(`limit=1&cursor=${first.nextCursor}`),
    )) as { data: { printerId: string }[]; nextCursor: string | null }
    expect(second.data.map((p) => p.printerId)).toEqual([printerA2])
    expect(second.nextCursor).toBeNull()
  })
})

describe('route policy', () => {
  it.each(['lots', 'vats', 'usage'])(
    'requires inventory:read for /resin/%s',
    (name) => {
      expect(integrationPolicy(`/resin/${name}`, 'GET')?.scopes).toEqual([
        'inventory:read',
      ])
      expect(integrationPolicy(`/resin/${name}`, 'POST')).toBeUndefined()
    },
  )
})
