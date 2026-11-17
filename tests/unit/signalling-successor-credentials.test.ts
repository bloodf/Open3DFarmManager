import { describe, expect, it, vi } from 'vitest'
import { PostgresSignallingAuthorization } from '../../apps/farm/server/storage/postgres-signalling-authorization.ts'
import type { Sql } from 'postgres'

describe('signalling successor authorization boundary', () => {
  const begin = vi.fn()
  const reader = new PostgresSignallingAuthorization(
    { begin } as unknown as Sql,
    {
      issuer: 'farm',
      origin: 'https://farm.example',
      audience: 'https://farm.example',
      idleTimeoutMs: 1_800_000,
    },
  )
  it('rejects malformed successor identities before opening a transaction', async () => {
    expect(await reader.readConnectorCurrent({ agentId: 'invalid' })).toEqual({
      kind: 'denied',
    })
    expect(begin).not.toHaveBeenCalled()
  })
  it('fails closed when credential storage is unavailable', async () => {
    begin.mockRejectedValueOnce(new Error('unavailable'))
    expect(
      await reader.readConnectorCurrent({
        agentId: '11111111-1111-4111-8111-111111111111',
        farmId: '22222222-2222-4222-8222-222222222222',
        jti: '33333333-3333-4333-8333-333333333333',
      }),
    ).toEqual({ kind: 'unavailable' })
    expect(begin).toHaveBeenCalledOnce()
  })
})

describe('successor credential lookup', () => {
  it('binds exact successor lookup to its root credential', async () => {
    const { readSignallingSuccessorRecords } =
      await import('../../apps/farm/server/storage/postgres-connector-credential-record.ts')
    const calls: { query: string; values: unknown[] }[] = []
    const tx = (parts: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ query: parts.join('?'), values })
      return []
    }
    await readSignallingSuccessorRecords(
      tx as never,
      'root-jti',
      'successor-jti',
      1000,
    )
    expect(calls[0]?.values).toEqual(['successor-jti'])
    expect(calls[0]?.query).toContain('s.jti =')
    expect(calls[1]?.values[0]).toBe('root-jti')
    expect(calls[1]?.query).toContain('s.root_jti =')
    expect(calls[1]?.query).toContain('ORDER BY s.ordinal DESC LIMIT 1')
  })
  it('uses database observation time to select a live successor', async () => {
    const { readSignallingSuccessorRecords } =
      await import('../../apps/farm/server/storage/postgres-connector-credential-record.ts')
    const calls: { query: string; values: unknown[] }[] = []
    const tx = (parts: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ query: parts.join('?'), values })
      return []
    }
    await readSignallingSuccessorRecords(tx as never, 'root-jti', null, 2000)
    expect(calls[0]?.values).toEqual([2000, 2000])
    expect(calls[0]?.query).toBe(
      's.issued_at * 1000 <= ? AND s.expires_at * 1000 > ?',
    )
  })
})
