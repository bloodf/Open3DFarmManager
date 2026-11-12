import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Sql } from 'postgres'
import { migrationCatalog } from '../../scripts/db/migrations.ts'
import {
  databaseReadiness,
  DatabaseStartupError,
  prepareSchema,
  readinessHttp,
  schemaState,
} from '../../apps/farm/server/utils/database/schema.ts'
import {
  assertSameDatabaseTargets,
  parseDatabaseRuntimeConfig,
} from '../../apps/farm/server/utils/database/runtime.ts'
import {
  databaseGateBlocks,
  databasePhase,
  setDatabasePhase,
} from '../../apps/farm/server/utils/database/phase.ts'
import { beginDatabaseStartup } from '../../apps/farm/server/utils/database/lifecycle.ts'
import { signallingSocketHooks } from '../../apps/farm/server/services/signalling-routes.ts'

const catalog = migrationCatalog([
  { name: '0001_a.up.sql', sql: 'SELECT 1' },
  { name: '0001_a.down.sql', sql: 'SELECT 1' },
  { name: '0002_b.up.sql', sql: 'SELECT 1' },
  { name: '0002_b.down.sql', sql: 'SELECT 1' },
])
const journal = (ids: number) =>
  catalog
    .slice(0, ids)
    .map((m, i) => ({ position: i + 1, id: m.id, checksum: m.checksum }))
const ahead = [
  ...journal(2),
  { position: 3, id: '0003_c', checksum: 'f'.repeat(64) },
]

// Minimal tagged-template stub: first query is to_regclass, second the journal.
function fakeSql(rows: unknown[] | 'no-table' | Error): Sql {
  return ((strings: TemplateStringsArray) => {
    const result =
      rows instanceof Error
        ? Promise.reject(rows)
        : Promise.resolve(
            strings.join('').includes('to_regclass')
              ? [{ name: rows === 'no-table' ? null : 'x' }]
              : rows === 'no-table'
                ? []
                : rows,
          )
    return Object.assign(result, { cancel() {} })
  }) as unknown as Sql
}

describe('schemaState', () => {
  test.each([
    ['no-table', 'pending'],
    [journal(0), 'pending'],
    [journal(1), 'pending'],
    [journal(2), 'current'],
    [ahead, 'ahead'],
    [[{ ...journal(2)[0], checksum: 'f'.repeat(64) }], 'mismatch'],
    [
      [{ ...journal(2)[0], checksum: 'f'.repeat(64) }, journal(2)[1], ahead[2]],
      'mismatch',
    ],
  ] as const)('%j -> %s', async (rows, expected) => {
    expect(await schemaState(fakeSql(rows as never), catalog)).toBe(expected)
  })
})

describe('prepareSchema (startup gate)', () => {
  test('resolves for current and for a journal ahead of the catalog', async () => {
    await expect(
      prepareSchema(fakeSql(journal(2)), catalog, 'verify'),
    ).resolves.toBeUndefined()
    await expect(
      prepareSchema(fakeSql(ahead), catalog, 'apply'),
    ).resolves.toBeUndefined()
  })
  test.each([journal(1), 'no-table'] as const)(
    'verify rejects pending',
    async (rows) => {
      await expect(
        prepareSchema(fakeSql(rows as never), catalog, 'verify'),
      ).rejects.toMatchObject({
        code: 'schema-pending',
      })
    },
  )
  test('rejects on mismatch with a fixed code', async () => {
    await expect(
      prepareSchema(
        fakeSql([{ ...journal(1)[0], id: 'zzz' }]),
        catalog,
        'verify',
      ),
    ).rejects.toMatchObject({ code: 'schema-mismatch' })
  })
  test('driver failures map to unreachable without the driver message', async () => {
    const error = await prepareSchema(
      fakeSql(new Error('connect ECONNREFUSED postgres://u:secret@h')),
      catalog,
      'verify',
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DatabaseStartupError)
    expect(String((error as Error).message)).not.toMatch(/secret|ECONN/)
    expect((error as DatabaseStartupError).code).toBe('unreachable')
  })
})

describe('databaseReadiness', () => {
  test('ok / ahead / pending / mismatch', async () => {
    expect(await databaseReadiness(fakeSql(journal(2)), catalog)).toBe('ok')
    expect(await databaseReadiness(fakeSql(ahead), catalog)).toBe('ahead')
    expect(await databaseReadiness(fakeSql(journal(1)), catalog)).toBe(
      'schema-pending',
    )
    expect(
      await databaseReadiness(
        fakeSql([{ position: 1, id: 'q', checksum: 'x' }]),
        catalog,
      ),
    ).toBe('schema-mismatch')
  })
  test('driver errors collapse to unavailable', async () => {
    expect(
      await databaseReadiness(
        fakeSql(new Error('password failed for u:secret@h')),
        catalog,
      ),
    ).toBe('unavailable')
  })
  test('timeout is bounded and cancels the pending query', async () => {
    const cancel = vi.fn()
    const hang = (() =>
      Object.assign(new Promise(() => {}), { cancel })) as unknown as Sql
    const started = Date.now()
    expect(await databaseReadiness(hang, catalog, 50)).toBe('unavailable')
    expect(Date.now() - started).toBeLessThan(1000)
    expect(cancel).toHaveBeenCalled()
  })
})

describe('readinessHttp', () => {
  test.each([
    [null, 200, 'ok', 'disabled'],
    ['ok', 200, 'ok', 'ok'],
    ['ahead', 200, 'ok', 'ahead'],
    ['unavailable', 503, 'unavailable', 'unavailable'],
    ['schema-pending', 503, 'unavailable', 'schema-pending'],
    ['schema-mismatch', 503, 'unavailable', 'schema-mismatch'],
  ] as const)('%s -> %i', (input, status, top, database) => {
    expect(readinessHttp(input)).toEqual({
      status,
      body: { status: top, checks: { database } },
    })
  })
})

describe('parseDatabaseRuntimeConfig', () => {
  const good = {
    enabled: true,
    databaseUrl: 'postgres://u:p@127.0.0.1:5433/db',
    migrations: 'verify',
    migrationsDir: '/app/migrations',
  }
  test('only unset or false is disabled', () => {
    expect(parseDatabaseRuntimeConfig(undefined)).toBeUndefined()
    expect(
      parseDatabaseRuntimeConfig({ ...good, enabled: false }),
    ).toBeUndefined()
    for (const enabled of ['true', 'yes', 1, null, 'false'])
      expect(() => parseDatabaseRuntimeConfig({ ...good, enabled })).toThrow(
        DatabaseStartupError,
      )
    expect(() => parseDatabaseRuntimeConfig('x')).toThrow(DatabaseStartupError)
  })
  test('valid config parses; invalid enabled config throws', () => {
    expect(parseDatabaseRuntimeConfig(good)).toEqual(good)
    expect(() =>
      parseDatabaseRuntimeConfig({ ...good, databaseUrl: '' }),
    ).toThrow()
    expect(() =>
      parseDatabaseRuntimeConfig({ ...good, migrations: 'x' }),
    ).toThrow()
    expect(() =>
      parseDatabaseRuntimeConfig({ ...good, migrationsDir: '' }),
    ).toThrow()
  })
})

describe('assertSameDatabaseTargets', () => {
  const config = parseDatabaseRuntimeConfig({
    enabled: true,
    databaseUrl: 'postgres://o:p@db.internal/app',
    migrations: 'verify',
    migrationsDir: '/m',
  })!
  test('same host/port/db (other roles) passes; disabled features ignored', () => {
    expect(() =>
      assertSameDatabaseTargets(config, {
        database: config,
        auth: {
          enabled: true,
          databaseUrl: 'postgres://r:q@db.internal:5432/app',
        },
        connectorPairing: {
          enabled: true,
          databaseUrl: 'postgres://a:b@db.internal/app',
          proofDatabaseUrl: 'postgres://c:d@db.internal/app',
        },
        browserDevices: {
          enabled: false,
          databaseUrl: 'postgres://x@other/zzz',
        },
        printerAssignments: { enabled: true, databaseUrl: '' },
      }),
    ).not.toThrow()
  })
  test.each([
    'postgres://r:q@other.internal/app',
    'postgres://r:q@db.internal:5433/app',
    'postgres://r:q@db.internal/other',
    'not a url',
  ])('%s fails closed', (databaseUrl) => {
    expect(() =>
      assertSameDatabaseTargets(config, {
        auth: { enabled: true, databaseUrl },
      }),
    ).toThrow('invalid database configuration')
  })
})

describe('gate and phase', () => {
  beforeEach(() => setDatabasePhase('disabled'))
  test('blocks everything but liveness/readiness until ready or disabled', () => {
    for (const phase of ['starting', 'failed'] as const) {
      setDatabasePhase(phase)
      expect(databaseGateBlocks('/api/farms')).toBe(true)
      expect(databaseGateBlocks('/')).toBe(true)
      expect(databaseGateBlocks('/healthz')).toBe(false)
      expect(databaseGateBlocks('/readyz')).toBe(false)
    }
    for (const phase of ['ready', 'disabled'] as const) {
      setDatabasePhase(phase)
      expect(databaseGateBlocks('/api/farms')).toBe(false)
    }
  })
  test('WebSocket upgrade is refused and destroyed while not ready', async () => {
    const lookup = vi.fn()
    const destroy = vi.fn()
    const request = { socket: { destroy } }
    setDatabasePhase('starting')
    const response = await signallingSocketHooks(
      'connector',
      'read-only',
      lookup as never,
    ).upgrade(request)
    expect(response).toBeInstanceOf(Response)
    expect((response as Response).status).toBe(503)
    expect(lookup).not.toHaveBeenCalled()
  })
})

describe('beginDatabaseStartup', () => {
  const good = {
    database: {
      enabled: true,
      databaseUrl: 'postgres://u:p@127.0.0.1:5433/db',
      migrations: 'verify',
      migrationsDir: '/m',
    },
  }
  const deps = (start: () => Promise<void>) => ({
    start,
    exit: vi.fn(),
    log: vi.fn(),
  })
  beforeEach(() => setDatabasePhase('disabled'))

  test('disabled: no phase change, no start', () => {
    const d = deps(vi.fn())
    expect(
      beginDatabaseStartup({ database: { enabled: false } }, d),
    ).toBeUndefined()
    expect(databasePhase()).toBe('disabled')
    expect(d.start).not.toHaveBeenCalled()
  })
  test('phase is starting synchronously, ready after start resolves', async () => {
    let release!: () => void
    const d = deps(() => new Promise<void>((resolve) => (release = resolve)))
    const settled = beginDatabaseStartup(good, d)
    expect(databasePhase()).toBe('starting')
    release()
    await settled
    expect(databasePhase()).toBe('ready')
    expect(d.exit).not.toHaveBeenCalled()
  })
  test('start failure logs a fixed message and exits 1', async () => {
    const d = deps(() =>
      Promise.reject(new Error('connect to u:secret@host failed')),
    )
    await beginDatabaseStartup(good, d)
    expect(databasePhase()).toBe('failed')
    expect(d.exit).toHaveBeenCalledWith(1)
    expect(d.log.mock.calls[0]?.[0]).toBe(
      'Database startup failed: database unreachable; refusing to serve',
    )
  })
  test('pending schema failure maps to its fixed message', async () => {
    const d = deps(() =>
      Promise.reject(new DatabaseStartupError('schema-pending')),
    )
    await beginDatabaseStartup(good, d)
    expect(d.log.mock.calls[0]?.[0]).toContain('pending migrations')
  })
  test('invalid config and mismatched feature target exit 1 before starting', () => {
    for (const root of [
      { database: { ...good.database, enabled: 'yes' } },
      {
        ...good,
        auth: { enabled: true, databaseUrl: 'postgres://u:p@other/db' },
      },
    ]) {
      setDatabasePhase('disabled')
      const d = deps(vi.fn())
      beginDatabaseStartup(root, d)
      expect(d.start).not.toHaveBeenCalled()
      expect(d.exit).toHaveBeenCalledWith(1)
      expect(databasePhase()).toBe('failed')
    }
  })
  test('close during start: never becomes ready and does not exit', async () => {
    let release!: () => void
    const d = deps(() => new Promise<void>((resolve) => (release = resolve)))
    const settled = beginDatabaseStartup(good, d)
    setDatabasePhase('failed') // what the close hook does
    release()
    await settled
    expect(databasePhase()).toBe('failed')
    expect(d.exit).not.toHaveBeenCalled()
  })
  test('close during a failing start does not exit either', async () => {
    let fail!: () => void
    const d = deps(
      () =>
        new Promise<void>((_, reject) => (fail = () => reject(new Error('x')))),
    )
    const settled = beginDatabaseStartup(good, d)
    setDatabasePhase('failed')
    fail()
    await settled
    expect(d.exit).not.toHaveBeenCalled()
  })
})
