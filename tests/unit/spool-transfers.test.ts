// SPDX-License-Identifier: AGPL-3.0-or-later
// Spool moves and per-farm isolation against a disposable PostgreSQL cluster.
import { randomUUID } from 'node:crypto'
import postgres, { type Sql } from 'postgres'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { login } from '../../apps/farm/server/services/authenticated-session.ts'
import { spoolMoves } from '../../apps/farm/server/services/spool-moves.ts'
import { spoolSlotsFeature } from '../../apps/farm/server/services/spool-slots-http.ts'
import { PostgresSpoolLibrary } from '../../apps/farm/server/storage/postgres-spool-library.ts'
import { PostgresSpoolMoves } from '../../apps/farm/server/storage/postgres-spool-moves.ts'
import { PostgresSpoolSlotAccess } from '../../apps/farm/server/storage/postgres-spool-slot-access.ts'
import { PostgresSpoolSlots } from '../../apps/farm/server/storage/postgres-spool-slots.ts'
import { PostgresSpoolmanSettings } from '../../apps/farm/server/storage/postgres-spoolman-settings.ts'
import { SESSION_COOKIE_NAME } from '../../apps/farm/server/utils/auth/boundary.ts'
import { hashPassword } from '../../apps/farm/server/utils/auth/password.ts'
import type { AuthRuntime } from '../../apps/farm/server/utils/auth/runtime.ts'
import { validateSpoolLibraryRole } from '../../apps/farm/server/utils/spool-library/role-policy.ts'
import {
  loadMigrationCatalog,
  runMigrations,
} from '../../scripts/db/migrations.ts'
import { disposablePostgres } from '../helpers/disposable-postgres.ts'
import { vitestPostgresOptions } from '../helpers/vitest-postgres.ts'

const origin = 'https://farm.example.invalid'
const farmA = '11111111-1111-4111-8111-111111111111'
const farmB = '22222222-2222-4222-8222-222222222222'
const farmC = '33333333-3333-4333-8333-333333333333'
const printerA = randomUUID()
const printerB = randomUUID()
const agentA = randomUUID()
const agentB = randomUUID()
const policy = { idleTimeoutMs: 10_000 }
const authority = (farmId: string, sessionRecordId: string) => ({
  farmId,
  sessionRecordId,
  policy,
})
/** owner: owns A and B. only-a / only-c: one farm. viewer-b: operates A, views B. */
const MEMBERS: Record<string, [string, string][]> = {
  owner: [
    [farmA, 'owner'],
    [farmB, 'owner'],
  ],
  'only-a': [[farmA, 'operator']],
  'only-b': [[farmB, 'owner']],
  'only-c': [[farmC, 'owner']],
  'viewer-b': [
    [farmA, 'operator'],
    [farmB, 'viewer'],
  ],
  'viewer-a': [[farmA, 'viewer']],
}

const fixture = disposablePostgres({
  ...vitestPostgresOptions('spool-moves'),
  isolated: true,
})
let root: Sql
let mover: Sql
let settingsSql: Sql
let moves: PostgresSpoolMoves
let clock = 500

function loginAs(role: string, name: string) {
  const url = new URL(fixture.connectionString)
  url.username = name
  url.password = 'synthetic-role-password'
  return root
    .unsafe(
      `CREATE ROLE ${name} LOGIN PASSWORD 'synthetic-role-password' IN ROLE ${role}`,
    )
    .then(() =>
      postgres(url.toString(), {
        max: 3,
        onnotice: () => {},
        connection: { search_path: 'pg_catalog' },
      }),
    )
}

async function seedFarm(
  farmId: string,
  printerId: string,
  agentId: string,
  spools: number,
) {
  await root`INSERT INTO farm.connector_enrollments (farm_id, agent_id, public_key_spki, fingerprint) VALUES (${farmId}, ${agentId}, repeat('A', 59), 'SHA256:' || repeat('A', 43))`
  await root`UPDATE farm.connector_enrollments SET status='approved' WHERE agent_id=${agentId}`
  await root`INSERT INTO farm.printer_assignments (id, farm_id, agent_id, printer_key, created_at, created_by) VALUES (${printerId}, ${farmId}, ${agentId}, 'sim-1', 100, 'owner')`
  await root`INSERT INTO farm.spool_vendors (farm_id, id, name, registered_at) VALUES (${farmId}, 1, ${'Fornecedor ' + farmId.slice(0, 1)}, 100)`
  await root`INSERT INTO farm.spool_filaments (farm_id, id, vendor_id, name, material, color_hex, density, diameter, weight, registered_at) VALUES (${farmId}, 1, 1, ${'PLA ' + farmId.slice(0, 1)}, 'PLA', 'FF0000', 1.24, 1.75, 1000, 100)`
  for (let id = 1; id <= spools; id++)
    await root`INSERT INTO farm.spools (farm_id, id, filament_id, initial_weight, used_weight, location, registered_at) VALUES (${farmId}, ${id}, 1, 1000, 250, 'Gaveta', 100)`
  await root`INSERT INTO farm.spool_library_counters (farm_id, kind, last_id) VALUES (${farmId}, 'vendor', 1), (${farmId}, 'filament', 1), (${farmId}, 'spool', ${spools})`
}

beforeAll(async () => {
  root = await fixture.start()
  for (const farm of [farmA, farmB, farmC])
    await root`INSERT INTO farm.farms (id) VALUES (${farm})`
  for (const [account, farms] of Object.entries(MEMBERS)) {
    await root`INSERT INTO farm.session_accounts (id) VALUES (${account})`
    await root`INSERT INTO farm.account_sessions (id, account_id, account_version, created_at, last_seen_at, absolute_expires_at) VALUES (${account}, ${account}, 0, 100, 100, 10000000)`
    for (const [farm, role] of farms)
      await root`INSERT INTO farm.memberships (farm_id, account_id, role) VALUES (${farm}, ${account}, ${role})`
  }
  await seedFarm(farmA, printerA, agentA, 6)
  await seedFarm(farmB, printerB, agentB, 1)
  mover = await loginAs(
    'farm_spool_library, farm_spool_features',
    'spool_move_login',
  )
  settingsSql = await loginAs('farm_spoolman_settings', 'spool_settings_login')
  moves = new PostgresSpoolMoves(mover, () => clock++)
}, 120_000)

afterAll(async () => {
  await mover?.end({ timeout: 3 })
  await settingsSql?.end({ timeout: 3 })
  await fixture.stop()
}, 60_000)

const spool = async (farmId: string, id: number) =>
  (
    await root`SELECT s.id::int AS id, s.used_weight AS "usedWeight", s.location, s.archived, f.name AS filament, f.color_hex AS color, v.name AS vendor FROM farm.spools s JOIN farm.spool_filaments f ON f.farm_id=s.farm_id AND f.id=s.filament_id LEFT JOIN farm.spool_vendors v ON v.farm_id=f.farm_id AND v.id=f.vendor_id WHERE s.farm_id=${farmId} AND s.id=${id}`
  )[0]
const bindings = (farmId: string, spoolId: number) =>
  root`SELECT slot_index::int AS slot, unassigned_at IS NULL AS open FROM farm.spool_slot_assignments WHERE farm_id=${farmId} AND spool_id=${spoolId} ORDER BY assigned_at, id`
const usage = (farmId: string) =>
  root`SELECT spool_id::int AS "spoolId", grams FROM farm.spool_usage_records WHERE farm_id=${farmId} ORDER BY created_at`
const journalSize = async () =>
  (await root`SELECT count(*)::int AS n FROM farm.spool_moves`)[0]!.n as number
const slot = (slotIndex: number, printerId = printerA) => ({
  to: 'slot' as const,
  printerId,
  slotKind: 'ams' as const,
  slotIndex,
})

describe('moves keep identity and history', () => {
  test('the library login with the new grants still passes its role policy', async () => {
    await expect(validateSpoolLibraryRole(mover)).resolves.toBeUndefined()
    await expect(
      mover`UPDATE farm.spool_moves SET moved_by='x'`,
    ).rejects.toMatchObject({ code: '42501' })
    await expect(mover`DELETE FROM farm.spool_moves`).rejects.toMatchObject({
      code: '42501',
    })
  })

  test('location move keeps the record and journals who moved it', async () => {
    const owner = authority(farmA, 'owner')
    const result = await moves.move(owner, 1, {
      to: 'location',
      location: '  Prateleira 2 ',
    })
    expect(result).toMatchObject({ moved: true, farmId: farmA, spoolId: 1 })
    expect(await spool(farmA, 1)).toMatchObject({
      location: 'Prateleira 2',
      usedWeight: 250,
      archived: false,
    })
    const before = await journalSize()
    expect(
      await moves.move(owner, 1, { to: 'location', location: 'Prateleira 2' }),
    ).toMatchObject({ moved: false, identity: result.identity })
    expect(await journalSize()).toBe(before)
    const history = await moves.history(owner, 1)
    expect(history.moves).toHaveLength(1)
    expect(history.moves[0]).toMatchObject({
      kind: 'location',
      movedBy: 'owner',
      from: { location: 'Gaveta' },
      to: { location: 'Prateleira 2' },
    })
  })

  test('slot moves keep earlier bindings and journal the displaced spool', async () => {
    const operator = authority(farmA, 'only-a')
    await moves.move(operator, 2, slot(0))
    await root`INSERT INTO farm.spool_usage_records (farm_id, id, spool_id, grams, source, created_at) VALUES (${farmA}, ${randomUUID()}, 2, 12.5, 'manual', 200)`
    await moves.move(operator, 2, slot(1))
    expect(await moves.move(operator, 2, slot(1))).toMatchObject({
      moved: false,
    })
    expect(await bindings(farmA, 2)).toEqual([
      { slot: 0, open: false },
      { slot: 1, open: true },
    ])
    await moves.move(operator, 3, slot(1))
    expect(await bindings(farmA, 2)).toEqual([
      { slot: 0, open: false },
      { slot: 1, open: false },
    ])
    expect(await bindings(farmA, 3)).toEqual([{ slot: 1, open: true }])
    expect((await moves.history(operator, 2)).moves[0]).toMatchObject({
      kind: 'slot',
      from: { slots: [{ slotIndex: 1 }] },
      to: { slots: [] },
    })
    expect(await usage(farmA)).toEqual([{ spoolId: 2, grams: 12.5 }])
  })

  test('a farm move continues the same spool and a return revives its row', async () => {
    const owner = authority(farmA, 'owner')
    await root`INSERT INTO farm.spool_usage_records (farm_id, id, spool_id, grams, source, created_at) VALUES (${farmA}, ${randomUUID()}, 4, 250, 'manual', 201)`
    await moves.move(owner, 4, slot(2))
    const there = await moves.move(owner, 4, {
      to: 'farm',
      farmId: farmB,
      location: 'Recebidas',
    })
    expect(there).toMatchObject({ moved: true, farmId: farmB, spoolId: 2 })
    expect(await spool(farmB, 2)).toEqual({
      id: 2,
      usedWeight: 250,
      location: 'Recebidas',
      archived: false,
      filament: 'PLA 1',
      color: 'FF0000',
      vendor: 'Fornecedor 1',
    })
    // The source keeps its row, usage and bindings; only the slot is freed.
    expect(await spool(farmA, 4)).toMatchObject({
      archived: true,
      usedWeight: 250,
    })
    expect(await bindings(farmA, 4)).toEqual([{ slot: 2, open: false }])
    expect(await usage(farmA)).toContainEqual({ spoolId: 4, grams: 250 })
    expect(await usage(farmB)).toEqual([])

    await expect(
      moves.move(owner, 4, { to: 'location', location: 'x' }),
    ).rejects.toMatchObject({ status: 409 })

    await root`UPDATE farm.spools SET used_weight=400 WHERE farm_id=${farmB} AND id=2`
    const back = await moves.move(authority(farmB, 'owner'), 2, {
      to: 'farm',
      farmId: farmA,
    })
    expect(back).toMatchObject({
      farmId: farmA,
      spoolId: 4,
      identity: there.identity,
    })
    expect(await spool(farmA, 4)).toMatchObject({
      archived: false,
      usedWeight: 400,
      location: null,
      filament: 'PLA 1',
    })
    expect(await spool(farmB, 2)).toMatchObject({ archived: true })

    // A second trip reuses both the destination row and the copied filament.
    expect(
      await moves.move(owner, 4, { to: 'farm', farmId: farmB }),
    ).toMatchObject({ spoolId: 2 })
    const counts =
      await root`SELECT (SELECT count(*)::int FROM farm.spool_filaments WHERE farm_id=${farmB}) AS filaments, (SELECT count(*)::int FROM farm.spool_vendors WHERE farm_id=${farmB}) AS vendors, (SELECT count(*)::int FROM farm.spools WHERE farm_id=${farmB}) AS spools`
    expect({ ...counts[0] }).toEqual({ filaments: 2, vendors: 2, spools: 2 })

    // A source row revived by hand cannot overwrite the spool where it now is.
    await root`UPDATE farm.spools SET archived=false WHERE farm_id=${farmA} AND id=4`
    await expect(
      moves.move(owner, 4, { to: 'farm', farmId: farmB }),
    ).rejects.toMatchObject({ status: 409 })
    await root`UPDATE farm.spools SET archived=true WHERE farm_id=${farmA} AND id=4`
  })

  test('history shows another farm only as far as the caller may see it', async () => {
    // only-b is a member of the destination, not of the source.
    const history = await moves.history(authority(farmB, 'only-b'), 2)
    const trips = history.moves.filter((move) => move.kind === 'farm')
    expect(trips).toHaveLength(3)
    expect(trips[0]).toMatchObject({
      source: { farmId: null, spoolId: null },
      destination: { farmId: farmB, spoolId: 2 },
      from: null,
    })
    // Moves made inside farm A never reach farm B.
    expect(history.moves.some((move) => move.kind === 'slot')).toBe(false)
    const both = await moves.history(authority(farmB, 'owner'), 2)
    expect(both.moves[0]).toMatchObject({
      source: { farmId: farmA, spoolId: 4 },
      from: null,
    })
  })
})

describe('unauthorized moves are refused and write nothing', () => {
  test.each([
    ['not a member of the destination', 'only-a', farmB, 404],
    ['not a member of an unknown farm', 'owner', farmC, 404],
    ['only a viewer in the destination', 'viewer-b', farmB, 403],
    ['not a member of the source', 'only-c', farmC, 404],
    ['same farm as destination', 'owner', farmA, 400],
  ])('%s', async (_label, session, destination, status) => {
    const before = await journalSize()
    const original = await spool(farmA, 5)
    await expect(
      moves.move(authority(farmA, session), 5, {
        to: 'farm',
        farmId: destination,
      }),
    ).rejects.toMatchObject({ status })
    expect(await spool(farmA, 5)).toEqual(original)
    expect(await journalSize()).toBe(before)
  })

  test('viewers, missing sessions and records of other farms', async () => {
    const before = await journalSize()
    const here = { to: 'location' as const, location: 'Outra' }
    await expect(
      moves.move(authority(farmA, 'viewer-a'), 5, here),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      moves.move(authority(farmA, 'nobody'), 5, here),
    ).rejects.toMatchObject({ status: 401 })
    await expect(
      moves.move(authority(farmB, 'only-a'), 1, here),
    ).rejects.toMatchObject({ status: 404 })
    // Spool 5 exists in farm A only.
    await expect(
      moves.move(authority(farmB, 'owner'), 5, here),
    ).rejects.toMatchObject({ status: 404 })
    await expect(
      moves.history(authority(farmB, 'owner'), 5),
    ).rejects.toMatchObject({ status: 404 })
    await expect(
      moves.history(authority(farmA, 'only-c'), 5),
    ).rejects.toMatchObject({ status: 404 })
    await expect(
      moves.move(authority(farmA, 'owner'), 5, slot(0, printerB)),
    ).rejects.toMatchObject({ status: 404 })
    expect(await journalSize()).toBe(before)
    expect(await spool(farmA, 5)).toMatchObject({ location: 'Gaveta' })
  })
})

describe('per-farm isolation', () => {
  test('a spool that has moved can still be deleted when nothing refers to it', async () => {
    const library = new PostgresSpoolLibrary(mover, () => clock++)
    await moves.move(authority(farmA, 'owner'), 5, {
      to: 'location',
      location: 'Descarte',
    })
    expect(
      await library.withScope(
        { kind: 'session', ...authority(farmA, 'owner') },
        (repo) => repo.spools.delete(5),
      ),
    ).toMatchObject({ ok: true })
  })

  test('the inventory repository never reaches another farm', async () => {
    const library = new PostgresSpoolLibrary(mover, () => clock++)
    const scope = (farmId: string, sessionRecordId: string) => ({
      kind: 'session' as const,
      ...authority(farmId, sessionRecordId),
    })
    expect(
      await library.withScope(scope(farmB, 'only-a'), (repo) =>
        repo.spools.get(1),
      ),
    ).toEqual({ ok: false, reason: 'forbidden' })
    // Spool 6 exists in farm A only: from farm B it is neither read nor written.
    for (const work of [
      (repo: Parameters<Parameters<typeof library.withScope>[1]>[0]) =>
        repo.spools.get(6),
      (repo: Parameters<Parameters<typeof library.withScope>[1]>[0]) =>
        repo.spools.update(6, { location: 'invadida' }),
      (repo: Parameters<Parameters<typeof library.withScope>[1]>[0]) =>
        repo.spools.delete(6),
    ])
      expect(
        await library.withScope<unknown>(scope(farmB, 'only-b'), work),
      ).toEqual({ ok: false, reason: 'not-found' })
    expect(await spool(farmA, 6)).toMatchObject({ location: 'Gaveta' })
  })

  test('Spoolman settings are read and written per farm', async () => {
    const settings = new PostgresSpoolmanSettings(settingsSql, () => clock++)
    const save = (farmId: string, session: string, agentId: string) =>
      settings.save({
        ...authority(farmId, session),
        agentId,
        origin: 'http://spoolman.invalid',
        serviceId: randomUUID(),
        status: 'reachable',
        configured: true,
      })
    expect(await save(farmB, 'only-b', agentB)).toMatchObject({ ok: true })
    expect(await settings.list(authority(farmB, 'only-a'))).toEqual({
      ok: false,
      reason: 'forbidden',
    })
    expect(await save(farmB, 'only-a', agentB)).toEqual({
      ok: false,
      reason: 'forbidden',
    })
    // Farm A's own member cannot name farm B's Connector.
    expect(await save(farmA, 'owner', agentB)).toEqual({
      ok: false,
      reason: 'forbidden',
    })
    expect(await settings.list(authority(farmA, 'owner'))).toMatchObject({
      ok: true,
      settings: [],
    })
  })
})

describe('HTTP boundary', () => {
  const cookieConfig = {
    name: SESSION_COOKIE_NAME,
    password: 'synthetic-moves-test-secret-32-characters!!',
    cookie: { secure: true, httpOnly: true, sameSite: 'lax', path: '/' },
  } satisfies AuthRuntime['cookie']
  let auth: AuthRuntime
  let cookie = ''

  beforeAll(async () => {
    const passwordHash = await hashPassword('synthetic-test-password')
    auth = {
      origin,
      cookie: cookieConfig,
      idleTimeoutMs: policy.idleTimeoutMs,
      lifetimeMs: 3_600_000,
      sessions: {
        async authorizeAndTouch() {
          throw new Error('unused')
        },
        async revokeSession() {},
        async revokeAccountSessions() {},
      },
      credentials: {
        async consumeLimit() {
          return true
        },
        async find() {
          return {
            accountId: 'owner',
            passwordHash,
            credentialVersion: '1',
            sessionVersion: '1',
          }
        },
        async issue() {
          return 'owner'
        },
      },
    }
    const event = {
      req: new Request(`${origin}/api/login`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({
          username: 'operator',
          password: 'synthetic-test-password',
        }),
      }),
      res: { headers: new Headers() },
    }
    await login(event, auth)
    cookie = event.res.headers.getSetCookie().at(-1)?.split(';')[0] ?? ''
  })

  const post = (
    body: unknown,
    headers: Record<string, string> = { cookie, origin },
  ) => ({
    req: new Request(`${origin}/api/farms/${farmA}/spool-library/spools/6`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    res: { headers: new Headers() },
  })
  const move = { to: 'location', location: 'Estante' }

  test('requires a session, the exact origin and a strict body', async () => {
    const deps = { auth, moves }
    for (const [event, status] of [
      [post(move, { origin }), 401],
      [post(move, { cookie, origin: 'https://evil.invalid' }), 403],
      [post({ ...move, farmId: farmB }), 400],
      [post({ to: 'nowhere' }), 400],
    ] as const)
      await expect(
        spoolMoves(event, farmA, '6', 'move', deps),
      ).rejects.toMatchObject({ status })
    await expect(
      spoolMoves(post(move), farmA, '06', 'move', deps),
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      spoolMoves(post(move), farmC, '1', 'move', deps),
    ).rejects.toMatchObject({ status: 404 })
    expect(
      await spoolMoves(post(move), farmA, '6', 'move', deps),
    ).toMatchObject({ moved: true })
  })

  test('assigning another farm spool or printer to a slot is a 404', async () => {
    const deps = {
      auth,
      access: new PostgresSpoolSlotAccess(mover, () => clock++),
      slots: new PostgresSpoolSlots(mover, () => clock++),
    }
    for (const body of [
      // Spool 6 belongs to farm A; the printer below to farm B.
      { spoolId: 6, printerId: printerB, slotKind: 'ams', slotIndex: 0 },
      { spoolId: 99, printerId: printerA, slotKind: 'ams', slotIndex: 0 },
    ])
      await expect(
        spoolSlotsFeature(post(body), farmA, 'assign', deps),
      ).rejects.toMatchObject({ status: 404 })
    expect(await bindings(farmA, 6)).toEqual([])
  })
})

test('migration 0116 reverses and reapplies', async () => {
  const catalog = await loadMigrationCatalog()
  const through = catalog.slice(
    0,
    catalog.findIndex((entry) => entry.id === '0116_spool_moves') + 1,
  )
  await runMigrations(root, through, {
    kind: 'down',
    expectedLastId: '0116_spool_moves',
  })
  const gone =
    await root`SELECT to_regclass('farm.spool_moves') AS moves, to_regclass('farm.spool_identities') AS identities`
  expect({ ...gone[0] }).toEqual({ moves: null, identities: null })
  await runMigrations(root, through, { kind: 'up' })
  expect(await journalSize()).toBe(0)
}, 60_000)
