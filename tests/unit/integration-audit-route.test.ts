import { afterEach, describe, expect, test, vi } from 'vitest'
import type { Sql } from 'postgres'
import { IntegrationLimits } from '../../apps/farm/server/utils/integration-auth-limits.ts'
import {
  listIntegrationAudit,
  type ListIntegrationAuditDeps,
} from '../../apps/farm/server/services/integration-audit-http.ts'

const farmId = '11111111-1111-4111-8111-111111111111'
const accountId = '22222222-2222-4222-8222-222222222222'

function pool(): Sql & { end: ReturnType<typeof vi.fn> } {
  const end = vi.fn(async () => {})
  return Object.assign(vi.fn(async () => []), { end }) as unknown as Sql & {
    end: ReturnType<typeof vi.fn>
  }
}

function deps(
  over: Partial<ListIntegrationAuditDeps> & { pool: Sql },
): ListIntegrationAuditDeps {
  return {
    accountId,
    farmId,
    query: {},
    rateLimits: new IntegrationLimits(() => 10_000),
    rateLimitConfig: { read: 120, write: 30 },
    listForOwner: async () => [],
    ...over,
  }
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('integration audit route (#589)', () => {
  test('repeated requests reuse one pool and never end it', async () => {
    const sql = pool()
    const first = await listIntegrationAudit(deps({ pool: sql }))
    const second = await listIntegrationAudit(deps({ pool: sql }))
    expect(first).toEqual({ entries: [], nextCursor: null })
    expect(second).toEqual({ entries: [], nextCursor: null })
    expect(sql.end).not.toHaveBeenCalled()
  })

  test('app read rate limit refuses further requests with a generic pt-BR error', async () => {
    const sql = pool()
    const rateLimits = new IntegrationLimits(() => 10_000)
    const shared = deps({
      pool: sql,
      rateLimits,
      rateLimitConfig: { read: 2, write: 30 },
    })
    await listIntegrationAudit(shared)
    await listIntegrationAudit(shared)
    await expect(listIntegrationAudit(shared)).rejects.toMatchObject({
      status: 429,
      message: 'Limite de solicitações atingido.',
    })
    expect(sql.end).not.toHaveBeenCalled()
  })

  test('route module takes the shared integration pool instead of postgres()', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(
        new URL(
          '../../apps/farm/server/api/farms/[farmId]/integrations/audit.get.ts',
          import.meta.url,
        ),
        'utf8',
      ),
    )
    expect(source).toContain('integrationAuthPool()')
    expect(source).not.toMatch(/\bpostgres\s*\(/)
    expect(source).not.toContain('sql.end')
  })
})
