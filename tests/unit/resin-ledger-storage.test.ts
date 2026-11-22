import { describe, expect, test } from 'vitest'
import type { Sql } from 'postgres'
import {
  PostgresResinLedger,
  ResinLedgerError,
} from '../../apps/farm/server/storage/resin-ledger-postgres.ts'

const farm = '11111111-1111-4111-8111-111111111111'
const printer = '22222222-2222-4222-8222-222222222222'
const policy = { idleTimeoutMs: 600_000 }

/** In-memory stand-in for the tagged-template client: no database needed. */
function fakeSql(role: string | null, ledgerRows: unknown[] = []) {
  const calls: { text: string; values: unknown[] }[] = []
  const tx = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?')
    calls.push({ text, values })
    if (text.includes('FROM farm.session_accounts'))
      return Promise.resolve([{ id: 'a1', sessionVersion: 1, disabled: false }])
    if (text.includes('FROM farm.account_sessions'))
      return Promise.resolve([
        {
          id: 's1',
          accountId: 'a1',
          accountVersion: 1,
          createdAt: 1000,
          lastSeenAt: 1000,
          absoluteExpiresAt: 10_000_000,
          revokedAt: null,
        },
      ])
    if (text.includes('FROM farm.memberships'))
      return Promise.resolve(role ? [{ role, revoked_at: null }] : [])
    if (text.includes('FROM farm.printer_assignments'))
      return Promise.resolve(values[1] === 'missing' ? [] : [{ id: printer }])
    if (text.includes('FROM farm.resin_ledger_entries'))
      return Promise.resolve(ledgerRows)
    return Promise.resolve([])
  }
  const sql = { begin: (work: (t: typeof tx) => unknown) => work(tx) }
  return { sql: sql as unknown as Sql, calls }
}
const authority = { farmId: farm, sessionRecordId: 's1', policy }
const bottle = {
  kind: 'bottle' as const,
  name: 'A',
  volumeMl: null,
  source: 'manual' as const,
}

describe('resin ledger storage', () => {
  test('persists a manual entry with unknown volume as NULL, never zero', async () => {
    const { sql, calls } = fakeSql('operator')
    const result = await new PostgresResinLedger(sql, () => 2000).run(
      authority,
      { op: 'record', printerKey: 'k1', entry: bottle },
    )
    expect(result).toMatchObject({ id: expect.any(String) })
    const insert = calls.find((c) =>
      c.text.includes('INSERT INTO farm.resin_ledger_entries'),
    )
    expect(insert?.values).toContain(null)
    expect(insert?.values).not.toContain(0)
    expect(insert?.values).toEqual(
      expect.arrayContaining([
        farm,
        printer,
        'bottle',
        'A',
        'manual',
        2000,
        'a1',
      ]),
    )
  })
  test('viewers cannot write; non-members and unknown printers are not found', async () => {
    const run = (role: string | null, key = 'k1') =>
      new PostgresResinLedger(fakeSql(role).sql, () => 2000).run(authority, {
        op: 'record',
        printerKey: key,
        entry: bottle,
      })
    await expect(run('viewer')).rejects.toMatchObject({ status: 403 })
    await expect(run(null)).rejects.toMatchObject({ status: 404 })
    await expect(run('owner', 'missing')).rejects.toBeInstanceOf(
      ResinLedgerError,
    )
  })
  test('refuses reported provenance from an account', async () => {
    const { sql, calls } = fakeSql('owner')
    await expect(
      new PostgresResinLedger(sql, () => 2000).run(authority, {
        op: 'record',
        printerKey: 'k1',
        entry: { ...bottle, source: 'reported' },
      }),
    ).rejects.toMatchObject({ status: 400 })
    expect(calls.some((c) => c.text.includes('INSERT'))).toBe(false)
  })
  test('lists entries scoped to the farm and the printer; viewers may read', async () => {
    const { sql, calls } = fakeSql('viewer', [
      {
        id: 'e1',
        kind: 'film',
        target: null,
        name: null,
        volumeMl: null,
        layers: 7,
        hours: null,
        source: 'reported',
        recordedAt: 5,
      },
      {
        id: 'bad',
        kind: 'film',
        layers: null,
        source: 'manual',
        recordedAt: 1,
      },
    ])
    const rows = await new PostgresResinLedger(sql, () => 2000).run(authority, {
      op: 'list',
      printerKey: 'k1',
    })
    expect(rows).toEqual([
      {
        id: 'e1',
        recordedAt: 5,
        entry: { kind: 'film', layers: 7, source: 'reported' },
      },
    ])
    const select = calls.find((c) =>
      c.text.includes('FROM farm.resin_ledger_entries'),
    )
    expect(select?.text).toContain('farm_id=')
    expect(select?.text).toContain('printer_id=')
  })
  test('rejects an expired session before touching the ledger', async () => {
    const { sql, calls } = fakeSql('owner')
    await expect(
      new PostgresResinLedger(sql, () => 99_999_999).run(authority, {
        op: 'list',
        printerKey: 'k1',
      }),
    ).rejects.toMatchObject({ status: 401 })
    expect(calls.some((c) => c.text.includes('resin_ledger_entries'))).toBe(
      false,
    )
  })
})
