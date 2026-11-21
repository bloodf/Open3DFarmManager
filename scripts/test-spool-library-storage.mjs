// Evidence for the farm-scoped spool library storage (migration 0085).
//
// PostgreSQL runs only in one task-owned Docker container (digest-pinned local
// postgres:17 image, never pulled, loopback port, read-only root, removed on
// exit). Everything else is in-process; there is no listening test server and
// nothing touches printers, host services or another task's resources.
//
//   node scripts/test-spool-library-storage.mjs
//
// Optional: SPOOL_LIBRARY_EVIDENCE_DIR (ledger + diagnostics, outside the repo),
// SPOOL_LIBRARY_TEST_IMAGE (a postgres:17@sha256:... reference present locally).
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import postgres from 'postgres'
import {
  POSTGRES_IMAGE_PATTERN,
  disposablePostgres,
} from '../tests/helpers/disposable-postgres.ts'
import { loadMigrationCatalog, runMigrations } from './db/migrations.ts'
import { PostgresSpoolLibrary } from '../apps/farm/server/storage/postgres-spool-library.ts'
import { validateSpoolLibraryRole } from '../apps/farm/server/utils/spool-library/role-policy.ts'
import { splitLegacyPath } from '../apps/farm/server/utils/spool-library/legacy-path.ts'

const exec = promisify(execFile)
const MIGRATION = '0085_spool_library_storage'
const LIBRARY_MIGRATION = '0087_spoolman_vendor_filament'
const TASK_LABEL = 'farm-storage-541'
const repoRoot = resolve(fileURLToPath(new URL('../', import.meta.url)))

if (process.argv.length !== 2)
  throw new Error(
    'No arguments accepted: node scripts/test-spool-library-storage.mjs',
  )

assert.equal(commandStderr({ stderr: 'docker: denied\n' }), 'docker: denied\n')
assert.equal(
  commandStderr({ stderr: Buffer.from('docker: no such image\n') }),
  'docker: no such image\n',
)
assert.equal(commandStderr(new Error('x')), '')

// --- external evidence directory (ledger + retained diagnostics) ------------
const evidenceDir = resolve(
  process.env.SPOOL_LIBRARY_EVIDENCE_DIR ??
    (await mkdtemp(join(tmpdir(), 'o3dfm-spool-storage-'))),
)
const inside = relative(repoRoot, evidenceDir)
if (inside === '' || (!inside.startsWith('..') && !inside.startsWith('/')))
  throw new Error('Evidence directory must be outside the repository')
await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
const ledgerPath = join(evidenceDir, 'ledger.jsonl')
const ledger = (entry) =>
  appendFileSync(
    ledgerPath,
    JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n',
  )

// --- local Docker only ------------------------------------------------------
const docker = async (...args) =>
  (
    await exec('docker', args, {
      timeout: 300_000,
      maxBuffer: 16 * 1024 * 1024,
    })
  ).stdout.trim()
const endpoint =
  process.env.DOCKER_HOST ??
  (await docker('context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'))
assert.match(endpoint, /^unix:\/\//, 'Only a local Docker daemon is allowed')
const image =
  process.env.SPOOL_LIBRARY_TEST_IMAGE ??
  (
    await docker(
      'image',
      'inspect',
      'postgres:17',
      '--format',
      '{{index .RepoDigests 0}}',
    )
  ).replace(/^postgres@/, 'postgres:17@')
assert.match(
  image,
  POSTGRES_IMAGE_PATTERN,
  'A digest-pinned postgres:17 image must already exist locally',
)

process.env.OPENFARM_PG = 'docker'
const containerName = `o3dfm-spool-storage-541-${randomBytes(4).toString('hex')}`
const fixture = disposablePostgres({
  name: containerName,
  labelKey: 'o3dfm.task',
  labelValue: TASK_LABEL,
  docker,
  image,
  ledger,
  through: MIGRATION,
  // Statement logging on, so the evidence can prove no secret reaches server logs.
  postgresArgs: ['-c', 'log_statement=all', '-c', 'log_min_messages=info'],
})

const checks = []
const check = (name) => checks.push(name)
let admin
let runtime
let failure
const secrets = []

try {
  admin = await fixture.start()
  ledger({
    resource: 'container',
    name: containerName,
    image,
    port: fixture.port,
  })

  // --- migration 0085 round trip (it is the last applied migration) ---------
  const catalog = (await loadMigrationCatalog()).slice(
    0,
    (await loadMigrationCatalog()).findIndex((m) => m.id === MIGRATION) + 1,
  )
  const hasTables = async () =>
    (
      await admin`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='farm' AND c.relname IN ('spool_vendors','spool_filaments','spools','spool_library_counters','spool_library_credentials')`
    )[0].n
  assert.equal(await hasTables(), 5)
  await runMigrations(admin, catalog, {
    kind: 'down',
    expectedLastId: MIGRATION,
  })
  assert.equal(await hasTables(), 0)
  assert.equal(
    (
      await admin`SELECT count(*)::int AS n FROM pg_roles WHERE rolname='farm_spool_library'`
    )[0].n,
    0,
  )
  await runMigrations(admin, catalog, { kind: 'up' })
  assert.equal(await hasTables(), 5)
  check('migration-0085-down-up-round-trip')
  // The repository reads the vendor/filament columns added by 0087.
  const libraryCatalog = await loadMigrationCatalog()
  await runMigrations(
    admin,
    libraryCatalog.slice(
      0,
      libraryCatalog.findIndex((m) => m.id === LIBRARY_MIGRATION) + 1,
    ),
    { kind: 'up' },
  )

  // --- least-privilege runtime role -----------------------------------------
  const role = 'spool_library_' + randomUUID().replaceAll('-', '')
  await admin`CREATE ROLE ${admin(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_spool_library`
  runtime = postgres({
    host: '127.0.0.1',
    port: fixture.port,
    database: 'fixture',
    username: role,
    password: '',
    ssl: false,
    max: 8,
    connect_timeout: 3,
    onnotice: () => {},
    connection: { search_path: 'pg_catalog' },
  })
  await validateSpoolLibraryRole(runtime)
  await assert.rejects(
    validateSpoolLibraryRole(admin),
    /Invalid spool library database role/,
  )
  const sqlState = async (promise) => {
    try {
      await promise
    } catch (error) {
      return error.code
    }
    return 'no-error'
  }

  // --- seed: two farms, members, a stranger ---------------------------------
  const farmA = randomUUID()
  const farmB = randomUUID()
  const people = {
    ownerA: [farmA, 'owner'],
    operatorA: [farmA, 'operator'],
    viewerA: [farmA, 'viewer'],
    ownerB: [farmB, 'owner'],
    stranger: [null, null],
  }
  await admin`INSERT INTO farm.farms (id) VALUES (${farmA}::uuid), (${farmB}::uuid)`
  for (const [who, [farm, memberRole]] of Object.entries(people)) {
    await admin`INSERT INTO farm.session_accounts (id) VALUES (${'acc-' + who})`
    await admin`INSERT INTO farm.account_sessions (id, account_id, account_version, created_at, last_seen_at, absolute_expires_at) VALUES (${'s-' + who}, ${'acc-' + who}, 0, 100, 100, 10000000)`
    if (farm)
      await admin`INSERT INTO farm.memberships (farm_id, account_id, role) VALUES (${farm}::uuid, ${'acc-' + who}, ${memberRole})`
  }
  let nowMs = 500
  const store = new PostgresSpoolLibrary(runtime, () => nowMs)
  const session = (who, farmId) => ({
    kind: 'session',
    sessionRecordId: 's-' + who,
    policy: { idleTimeoutMs: 1_000_000 },
    farmId: farmId ?? people[who][0],
  })
  const manage = (who, farmId) => {
    const { sessionRecordId, policy, farmId: f } = session(who, farmId)
    return { sessionRecordId, policy, farmId: f }
  }
  const must = (result) => {
    assert.equal(result.ok, true, JSON.stringify(result))
    return result.value
  }
  const reason = (result) => (result.ok ? 'ok' : result.reason)

  // --- credential management is owner/admin of that farm only ---------------
  assert.equal(
    reason(
      await store.issueLegacyCredential({
        ...manage('operatorA'),
        label: 'x',
        access: 'write',
      }),
    ),
    'denied',
  )
  assert.equal(
    reason(
      await store.issueLegacyCredential({
        ...manage('viewerA'),
        label: 'x',
        access: 'write',
      }),
    ),
    'denied',
  )
  assert.equal(
    reason(
      await store.issueLegacyCredential({
        ...manage('stranger', farmA),
        label: 'x',
        access: 'write',
      }),
    ),
    'forbidden',
  )
  assert.equal(
    reason(
      await store.issueLegacyCredential({
        ...manage('ownerB', farmA),
        label: 'x',
        access: 'write',
      }),
    ),
    'forbidden',
    'a member of another farm cannot issue a credential for this farm',
  )
  assert.equal(
    reason(
      await store.issueLegacyCredential({
        ...manage('ownerA'),
        label: ' padded ',
        access: 'write',
      }),
    ),
    'invalid-input',
  )
  check('credential-management-owner-admin-of-the-farm-only')

  const issuedA = must(
    await store.issueLegacyCredential({
      ...manage('ownerA'),
      label: 'moonraker-a1',
      access: 'write',
    }),
  )
  const issuedARead = must(
    await store.issueLegacyCredential({
      ...manage('ownerA'),
      label: 'read-only',
      access: 'read',
    }),
  )
  const issuedB = must(
    await store.issueLegacyCredential({
      ...manage('ownerB'),
      label: 'moonraker-b1',
      access: 'write',
    }),
  )
  const secretOf = (token) => token.split('.')[2]
  secrets.push(
    ...[issuedA, issuedARead, issuedB].map((i) => i.token),
    ...[issuedA, issuedARead, issuedB].map((i) => secretOf(i.token)),
  )
  assert.match(issuedA.token, /^sl1\.[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/)
  check('per-farm-credentials-issued-with-256-bit-secrets')

  // --- storage never holds the token ----------------------------------------
  const stored = JSON.stringify(
    await admin`SELECT row_to_json(c)::text AS r FROM farm.spool_library_credentials c`,
  )
  for (const secret of secrets)
    assert.ok(!stored.includes(secret), 'credential secret stored')
  assert.equal(
    (
      await admin`SELECT count(*)::int AS n FROM farm.spool_library_credentials WHERE secret_sha256 ~ '^[0-9a-f]{64}$'`
    )[0].n,
    3,
  )
  check('only-a-sha256-of-the-secret-is-stored')

  // --- session scope: per-farm ids, role access, no cross-farm access -------
  const A = (who) => session(who, farmA)
  const vendorA = must(
    await store.withScope(A('operatorA'), (r) =>
      r.vendors.create({ name: 'Polymaker', extra: { origin: 'cn' } }),
    ),
  )
  assert.equal(vendorA.id, 1)
  assert.deepEqual(vendorA.extra, { origin: 'cn' })
  assert.equal(
    reason(
      await store.withScope(A('viewerA'), (r) =>
        r.vendors.create({ name: 'nope' }),
      ),
    ),
    'denied',
  )
  assert.equal(
    must(
      await store.withScope(A('viewerA'), (r) => r.vendors.list({ limit: 10 })),
    ).length,
    1,
  )
  assert.equal(
    reason(
      await store.withScope(session('stranger', farmA), (r) =>
        r.vendors.list({ limit: 10 }),
      ),
    ),
    'forbidden',
  )
  assert.equal(
    reason(
      await store.withScope(session('ownerA', farmB), (r) =>
        r.vendors.list({ limit: 10 }),
      ),
    ),
    'forbidden',
    'farm A owner cannot open a farm B scope',
  )
  assert.equal(
    reason(
      await store.withScope(
        { ...A('ownerA'), sessionRecordId: 's-ownerB' },
        (r) => r.vendors.list({ limit: 10 }),
      ),
    ),
    'forbidden',
    "another farm's session cannot be pointed at this farm",
  )
  check('session-roles-and-membership-bound-the-farm')

  // Farm B gets its own id space; farm A has 1 filament, farm B has 3.
  const filamentA = must(
    await store.withScope(A('ownerA'), (r) =>
      r.filaments.create({
        vendorId: vendorA.id,
        name: 'PLA Blue',
        material: 'PLA',
        colorHex: '0000FF',
        density: 1.24,
        diameter: 1.75,
        weight: 1000,
      }),
    ),
  )
  assert.equal(filamentA.id, 1)
  const B = (who = 'ownerB') => session(who, farmB)
  must(await store.withScope(B(), (r) => r.vendors.create({ name: 'eSun' })))
  for (const name of ['PETG Red', 'ABS Black', 'TPU Clear'])
    must(
      await store.withScope(B(), (r) =>
        r.filaments.create({ name, density: 1.2, diameter: 1.75 }),
      ),
    )
  const spoolB = must(
    await store.withScope(B(), (r) =>
      r.spools.create({
        filamentId: 3,
        initialWeight: 800,
        comment: 'farm B secret spool',
      }),
    ),
  )
  assert.equal(spoolB.id, 1)
  const spoolA = must(
    await store.withScope(A('operatorA'), (r) =>
      r.spools.create({
        filamentId: filamentA.id,
        initialWeight: 1000,
        spoolWeight: 200,
        location: 'shelf A1',
      }),
    ),
  )
  assert.equal(spoolA.id, 1, 'same integer id in two farms, separate rows')
  assert.equal(
    must(await store.withScope(A('viewerA'), (r) => r.spools.get(1))).location,
    'shelf A1',
  )
  assert.equal(
    must(await store.withScope(B(), (r) => r.spools.get(1))).comment,
    'farm B secret spool',
  )
  assert.equal(
    reason(await store.withScope(A('ownerA'), (r) => r.filaments.get(3))),
    'not-found',
    "farm B's filament id does not exist in farm A",
  )
  check('per-farm-integer-ids-and-isolated-reads')

  // A spool, filament or vendor reference never crosses farms.
  assert.equal(
    reason(
      await store.withScope(A('ownerA'), (r) =>
        r.spools.create({ filamentId: 3 }),
      ),
    ),
    'conflict',
    "farm A cannot attach a spool to farm B's filament id",
  )
  assert.equal(
    reason(
      await store.withScope(A('ownerA'), (r) =>
        r.filaments.create({ vendorId: 1, density: 1, diameter: 1.75 }),
      ),
    ),
    'ok',
  )
  assert.equal(
    reason(
      await store.withScope(A('ownerA'), (r) =>
        r.filaments.create({ vendorId: 2, density: 1, diameter: 1.75 }),
      ),
    ),
    'conflict',
  )
  assert.equal(
    reason(
      await store.withScope(A('ownerA'), (r) =>
        r.spools.update(2, { comment: 'x' }),
      ),
    ),
    'not-found',
  )
  assert.equal(
    reason(await store.withScope(A('ownerA'), (r) => r.spools.delete(2))),
    'not-found',
  )
  assert.equal(
    reason(await store.withScope(A('ownerA'), (r) => r.spools.use(2, 5))),
    'not-found',
  )
  // The rejected writes left the transaction usable and wrote nothing.
  assert.equal(
    must(await store.withScope(B(), (r) => r.spools.get(1))).usedWeight,
    0,
  )
  check('cross-farm-references-and-writes-rejected')

  // Database-level backstop: even raw SQL from the runtime role cannot cross farms.
  // Vendor id 2 exists only in farm B, filament id 3 only in farm B.
  must(
    await store.withScope(B(), (r) => r.vendors.create({ name: 'Prusament' })),
  )
  assert.equal(
    await sqlState(
      runtime`INSERT INTO farm.spools (farm_id, id, filament_id, registered_at) VALUES (${farmA}::uuid, 900, 3, 1)`,
    ),
    '23503',
  )
  assert.equal(
    await sqlState(
      runtime`INSERT INTO farm.spool_filaments (farm_id, id, vendor_id, density, diameter, registered_at) VALUES (${farmA}::uuid, 900, 2, 1, 1.75, 1)`,
    ),
    '23503',
  )
  assert.equal(
    await sqlState(
      runtime`UPDATE farm.spool_library_credentials SET secret_sha256 = repeat('0', 64)`,
    ),
    '42501',
  )
  assert.equal(
    await sqlState(runtime`DELETE FROM farm.spool_library_credentials`),
    '42501',
  )
  assert.equal(
    await sqlState(runtime`SELECT 1 FROM farm.connector_enrollments LIMIT 1`),
    '42501',
  )
  assert.equal(
    await sqlState(runtime`UPDATE farm.spools SET farm_id = ${farmB}::uuid`),
    '42501',
    'the role cannot re-home a row',
  )
  assert.equal(
    await sqlState(runtime`UPDATE farm.spools SET id = id + 1000`),
    '42501',
  )
  check('database-constraints-and-role-grants-backstop-the-store')

  // A scope is atomic: a failure after an earlier write leaves nothing behind.
  const atomic = await store.withScope(A('ownerA'), async (r) => {
    must(await r.vendors.create({ name: 'rolled back' }))
    return r.spools.get(999999)
  })
  assert.equal(reason(atomic), 'not-found')
  assert.equal(
    must(
      await store.withScope(A('ownerA'), (r) => r.vendors.list({ limit: 50 })),
    ).some((v) => v.name === 'rolled back'),
    false,
  )
  check('failed-scope-rolls-back-its-writes')

  // --- unauthenticated legacy client: URL credential only -------------------
  // A legacy client sends no cookie and no Authorization header, only a URL.
  const legacy = async (token, pathname, work) => {
    const split = splitLegacyPath(pathname)
    if (!split.ok) return { ok: false, reason: 'unauthorized' }
    return store.withScope(
      { kind: 'legacy-credential', token: split.token },
      work,
    )
  }
  const urlA = `/spoolman/${issuedA.token}/api/v1/spool/1`
  const viaLegacy = must(
    await legacy(issuedA.token, urlA, (r) => r.spools.get(1)),
  )
  assert.equal(viaLegacy.location, 'shelf A1')
  assert.equal(
    must(await legacy(issuedA.token, urlA, (r) => r.spools.use(1, 12.5)))
      .usedWeight,
    12.5,
  )
  assert.equal(
    must(await legacy(issuedA.token, urlA, (r) => r.spools.use(1, 7.5)))
      .usedWeight,
    20,
  )
  assert.ok(
    (must(await legacy(issuedA.token, urlA, (r) => r.spools.get(1)))
      .firstUsedAt ?? 0) >= 500,
  )
  assert.equal(
    must(
      await legacy(issuedA.token, urlA, (r) =>
        Promise.resolve({ ok: true, value: r.farmId }),
      ),
    ),
    farmA,
  )
  assert.equal(
    must(
      await legacy(
        issuedB.token,
        `/spoolman/${issuedB.token}/api/v1/spool/1`,
        (r) => Promise.resolve({ ok: true, value: r.farmId }),
      ),
    ),
    farmB,
  )
  // Moonraker also reaches the root of its server URL and a websocket path.
  assert.equal(
    splitLegacyPath(`/spoolman/${issuedA.token}/api/v1/spool`).apiPath,
    '/api/v1/spool',
  )
  assert.equal(splitLegacyPath(`/spoolman/${issuedA.token}`).apiPath, '/')
  check('unauthenticated-legacy-client-reads-and-reports-usage-for-its-farm')

  // --- legacy access cannot cross farms -------------------------------------
  assert.equal(
    reason(await legacy(issuedA.token, urlA, (r) => r.filaments.get(3))),
    'not-found',
  )
  assert.equal(
    must(
      await legacy(issuedA.token, urlA, (r) => r.spools.list({ limit: 100 })),
    ).every((s) => s.comment !== 'farm B secret spool'),
    true,
  )
  assert.equal(
    reason(
      await legacy(issuedA.token, urlA, (r) =>
        r.spools.create({ filamentId: 3 }),
      ),
    ),
    'conflict',
  )
  const aSecret = secretOf(issuedA.token)
  const bSecret = secretOf(issuedB.token)
  const idOf = (token) => token.split('.')[1]
  const forged = [
    `sl1.${idOf(issuedA.token)}.${bSecret}`, // A's id with B's secret
    `sl1.${idOf(issuedA.token)}.${randomBytes(32).toString('base64url')}`,
    `sl1.${randomBytes(16).toString('hex')}.${aSecret}`, // unknown id
    issuedA.token.slice(0, -1) + (issuedA.token.endsWith('A') ? 'B' : 'A'),
    `sl2.${idOf(issuedA.token)}.${aSecret}`,
    `${issuedA.token}x`,
    '',
    'sl1..',
  ]
  for (const token of forged)
    assert.equal(
      reason(
        await store.withScope({ kind: 'legacy-credential', token }, (r) =>
          r.spools.get(1),
        ),
      ),
      'unauthorized',
      'forged credential accepted',
    )
  for (const path of [
    `/spoolman/${issuedA.token}/../x`,
    `/spoolman/${issuedA.token}//x`,
    `/spoolman/%73l1/x`,
    '/other/x',
    `/spoolman/${'a'.repeat(600)}`,
  ])
    assert.equal(
      splitLegacyPath(path).ok,
      false,
      'malformed legacy path accepted',
    )
  check('forged-wrong-and-cross-farm-credentials-rejected')

  // --- read-only credential never mutates ------------------------------------
  const readOnly = (work) =>
    store.withScope(
      { kind: 'legacy-credential', token: issuedARead.token },
      work,
    )
  assert.equal(must(await readOnly((r) => r.spools.get(1))).usedWeight, 20)
  assert.equal(reason(await readOnly((r) => r.spools.use(1, 1))), 'denied')
  assert.equal(
    reason(await readOnly((r) => r.spools.create({ filamentId: 1 }))),
    'denied',
  )
  assert.equal(reason(await readOnly((r) => r.vendors.delete(1))), 'denied')
  assert.equal(must(await readOnly((r) => r.spools.get(1))).usedWeight, 20)
  check('read-only-credential-cannot-mutate')

  // --- concurrent first use of a fresh credential neither deadlocks nor fails
  const fresh = must(
    await store.issueLegacyCredential({
      ...manage('ownerA'),
      label: 'fresh',
      access: 'read',
    }),
  )
  secrets.push(fresh.token, secretOf(fresh.token))
  const burst = await Promise.all(
    Array.from({ length: 10 }, () =>
      store.withScope({ kind: 'legacy-credential', token: fresh.token }, (r) =>
        r.spools.get(1),
      ),
    ),
  )
  assert.deepEqual(burst.map(reason), Array(10).fill('ok'))
  check('concurrent-first-use-of-a-credential')

  // --- concurrent allocation stays unique and dense per farm ----------------
  const created = await Promise.all(
    Array.from({ length: 12 }, () =>
      legacy(issuedA.token, urlA, (r) =>
        r.spools.create({ filamentId: 1, initialWeight: 1 }),
      ),
    ),
  )
  const ids = created.map((r) => must(r).id).sort((a, b) => a - b)
  assert.deepEqual(
    ids,
    Array.from({ length: 12 }, (_, i) => i + 2),
  )
  assert.equal(
    must(await store.withScope(B(), (r) => r.spools.list({ limit: 100 })))
      .length,
    1,
  )
  check('concurrent-id-allocation-is-unique-per-farm')

  // --- listing and last-use bookkeeping --------------------------------------
  const listed = must(await store.listLegacyCredentials(manage('ownerA')))
  assert.deepEqual(listed.map((c) => c.label).sort(), [
    'fresh',
    'moonraker-a1',
    'read-only',
  ])
  assert.ok(listed.every((c) => c.revokedAt === null))
  assert.ok(listed.find((c) => c.label === 'moonraker-a1').lastUsedAt !== null)
  assert.equal(JSON.stringify(listed).includes(aSecret), false)
  assert.equal(
    reason(await store.listLegacyCredentials(manage('ownerB', farmA))),
    'forbidden',
  )
  assert.equal(
    reason(await store.listLegacyCredentials(manage('operatorA'))),
    'denied',
  )
  assert.equal(
    must(await store.listLegacyCredentials(manage('ownerB'))).length,
    1,
  )
  check('credential-listing-is-farm-scoped-and-secret-free')

  // --- revocation is immediate and farm-scoped -------------------------------
  assert.equal(
    reason(
      await store.revokeLegacyCredential({
        ...manage('ownerB'),
        credentialId: issuedA.credential.id,
      }),
    ),
    'not-found',
    "farm B owner cannot revoke farm A's credential",
  )
  assert.equal(
    reason(
      await store.revokeLegacyCredential({
        ...manage('operatorA'),
        credentialId: issuedA.credential.id,
      }),
    ),
    'denied',
  )
  assert.equal(
    must(await legacy(issuedA.token, urlA, (r) => r.spools.get(1))).id,
    1,
  )
  must(
    await store.revokeLegacyCredential({
      ...manage('ownerA'),
      credentialId: issuedA.credential.id,
    }),
  )
  assert.equal(
    reason(await legacy(issuedA.token, urlA, (r) => r.spools.get(1))),
    'unauthorized',
  )
  assert.equal(
    must(
      await legacy(issuedB.token, `/spoolman/${issuedB.token}/x`, (r) =>
        r.spools.get(1),
      ),
    ).id,
    1,
    'farm B client unaffected',
  )
  assert.ok(
    must(await store.listLegacyCredentials(manage('ownerA'))).find(
      (c) => c.id === issuedA.credential.id,
    ).revokedAt !== null,
  )
  const replacement = must(
    await store.issueLegacyCredential({
      ...manage('ownerA'),
      label: 'rotated',
      access: 'write',
    }),
  )
  secrets.push(replacement.token, secretOf(replacement.token))
  assert.equal(
    must(
      await legacy(replacement.token, `/spoolman/${replacement.token}/x`, (r) =>
        r.spools.get(1),
      ),
    ).usedWeight,
    20,
  )
  check('revocation-immediate-farm-scoped-and-rotation-works')

  // --- credential count is bounded, even when issued concurrently ------------
  const bulk = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      store.issueLegacyCredential({
        ...manage('ownerB'),
        label: 'bulk-' + i,
        access: 'read',
      }),
    ),
  )
  for (const result of bulk)
    if (result.ok)
      secrets.push(result.value.token, secretOf(result.value.token))
  assert.equal(bulk.filter((r) => r.ok).length, 15)
  assert.ok(bulk.filter((r) => !r.ok).every((r) => r.reason === 'limit'))
  assert.equal(
    must(await store.listLegacyCredentials(manage('ownerB'))).filter(
      (c) => c.revokedAt === null,
    ).length,
    16,
  )
  check('active-credentials-per-farm-bounded')

  // --- failures and logs never expose a secret --------------------------------
  const failures = JSON.stringify([
    await store.withScope(
      { kind: 'legacy-credential', token: forged[0] },
      (r) => r.spools.get(1),
    ),
    await legacy(issuedA.token, urlA, (r) => r.spools.get(1)),
    await store.issueLegacyCredential({
      ...manage('stranger', farmA),
      label: 'x',
      access: 'write',
    }),
  ])
  for (const secret of secrets) assert.ok(!failures.includes(secret))
  const fullLog = await exec('docker', ['logs', containerName], {
    maxBuffer: 64 * 1024 * 1024,
  }).then((r) => r.stdout + r.stderr)
  assert.ok(
    fullLog.includes('spool_library_credentials'),
    'statement logging must be active for this check',
  )
  for (const secret of secrets)
    assert.ok(
      !fullLog.includes(secret),
      'a credential secret reached the PostgreSQL log',
    )
  check('no-credential-secret-in-results-storage-or-server-logs')

  await fixture.logs().catch(() => '')
  console.log(
    JSON.stringify(
      { ok: true, container: containerName, image, evidenceDir, checks },
      null,
      2,
    ),
  )
} catch (error) {
  failure = error
  process.exitCode = 1
  // Retain bounded diagnostics before the container is removed.
  const diagnostics = {
    error: redact(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    ).slice(0, 16384),
    stderr: redact(commandStderr(error)).slice(0, 16384),
    stdout: redact(commandText(error?.stdout)).slice(0, 16384),
    signal: error?.signal ?? null,
    killed: error?.killed === true,
    exitCode: error?.code ?? null,
    checksPassed: checks,
    container: containerName,
    image,
  }
  await writeFile(
    join(evidenceDir, 'failure.json'),
    JSON.stringify(diagnostics, null, 2),
    { mode: 0o600 },
  ).catch(() => {})
  await exec('docker', ['logs', '--tail', '400', containerName], {
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  })
    .then(({ stdout, stderr }) =>
      writeFile(
        join(evidenceDir, 'postgres-container.log'),
        redact(stdout + stderr),
        { mode: 0o600 },
      ),
    )
    .catch(() => {})
  console.error(
    `FAILED after ${checks.length} checks: ${redact(error instanceof Error ? error.message : String(error))}`,
  )
  console.error(`Diagnostics retained in ${evidenceDir}`)
} finally {
  await runtime?.end({ timeout: 3 }).catch(() => {})
  let cleanupFailed = false
  try {
    await fixture.stop()
  } catch (error) {
    // A loaded host can make `docker rm -f` slow; removal may still complete.
    console.error(
      `Container removal reported: ${redact(String(error)).split('\n', 1)[0]}`,
    )
  }
  // A slow daemon can finish creating the container after a start failure, so
  // keep checking by exact name and remove only our own label-verified container.
  let leftover = ''
  for (let attempt = 0; attempt < 45; attempt++) {
    leftover = await docker(
      'ps',
      '-aq',
      '--filter',
      `name=^/${containerName}$`,
    ).catch(() => 'unknown')
    if (leftover === '') break
    if (/^[a-f0-9]+$/.test(leftover))
      await docker(
        'inspect',
        '--format',
        '{{index .Config.Labels "o3dfm.task"}}',
        leftover,
      )
        .then((label) =>
          label === TASK_LABEL ? docker('rm', '-f', leftover) : undefined,
        )
        .catch(() => {})
    await new Promise((done) => setTimeout(done, 2000))
  }
  cleanupFailed = leftover !== ''
  ledger({
    cleanup: 'container',
    name: containerName,
    remaining: leftover === '' ? 'none' : leftover,
  })
  if (cleanupFailed) {
    process.exitCode = 1
    console.error(
      `Cleanup incomplete: container ${containerName} still present`,
    )
  } else
    console.log(
      `Cleanup: container ${containerName} removed; ledger ${ledgerPath}`,
    )
}

/** execFile stdout/stderr may be a string or a Buffer. */
function commandText(value) {
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8')
  return ''
}

/** execFile stderr may be a string or a Buffer. Empty when the failure has none. */
function commandStderr(error) {
  const raw =
    error && typeof error === 'object' && 'stderr' in error ? error.stderr : ''
  return commandText(raw)
}

/** Diagnostics never keep a credential: mask anything shaped like one. */
function redact(text) {
  let out = text
    .replace(/(\/spoolman\/)[^/\s?#]+/g, '$1<redacted>')
    .replace(/sl1\.[0-9a-f]{32}\.[A-Za-z0-9_-]{43}/g, 'sl1.<redacted>')
    .replace(/(postgres(?:ql)?:\/\/)[^/\s]+@/gi, '$1<redacted>@')
  for (const secret of secrets) out = out.replaceAll(secret, '<redacted>')
  return out
}
