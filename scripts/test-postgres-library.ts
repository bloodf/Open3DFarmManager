// Synthetic PostgreSQL only. Caller owns the database, migrations (through 0057) and teardown.
// Library store + blob store: dedupe, per-farm storage mode, crash safety, quota, roles.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import postgres from 'postgres'
import {
  BlobStoreError,
  createBlobStore,
  parseRange,
} from '../apps/farm/server/utils/library/blob-store.ts'
import {
  PostgresLibrary,
  type AddVersionInput,
} from '../apps/farm/server/utils/library/store.ts'

const portText = process.env.LIBRARY_SYNTHETIC_TEST_PORT
const port = Number(portText)
if (
  process.argv.length !== 2 ||
  process.env.LIBRARY_SYNTHETIC_TEST_DISPOSABLE !== 'yes' ||
  typeof portText !== 'string' ||
  !/^[0-9]{4,5}$/.test(portText) ||
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535
)
  throw new Error(
    'Explicit disposable loopback PostgreSQL port required; no arguments accepted',
  )

const sha = (data: string) => createHash('sha256').update(data).digest('hex')
const bytes = (data: string) => Readable.from([Buffer.from(data)])
const text = async (stream: AsyncIterable<Uint8Array>) => {
  const parts: Buffer[] = []
  for await (const part of stream) parts.push(Buffer.from(part))
  return Buffer.concat(parts).toString()
}

const role = 'library_fixture_' + randomUUID().replaceAll('-', '')
const options = {
  host: '127.0.0.1',
  port,
  database: 'fixture',
  password: '',
  ssl: false as const,
  max: 6,
  connect_timeout: 3,
}
const admin = postgres({ ...options, username: 'fixture' })
const runtime = postgres({ ...options, username: role })
const dir = await mkdtemp(join(tmpdir(), 'openfarm-library-test-'))
let roleCreated = false
const checks: string[] = []
const check = (name: string) => checks.push(name)
const files = async () =>
  (await readdir(dir)).filter((name) => name !== '.tmp').sort()

try {
  assert.equal(
    (
      await admin`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'farm' AND table_name = 'library_versions'`
    )[0]?.n,
    1,
    'Apply migration 0056 before running this fixture',
  )
  await admin`CREATE ROLE ${admin(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_library`
  roleCreated = true

  // Seed: one farm with owner/operator/viewer, one foreign farm, one approved Connector.
  const [farm, otherFarm, agent] = [randomUUID(), randomUUID(), randomUUID()]
  const people = {
    owner: 'acc-owner',
    operator: 'acc-op',
    viewer: 'acc-view',
    stranger: 'acc-out',
  }
  await admin`INSERT INTO farm.farms (id) VALUES (${farm}::uuid), (${otherFarm}::uuid)`
  for (const [kind, account] of Object.entries(people)) {
    await admin`INSERT INTO farm.session_accounts (id) VALUES (${account})`
    await admin`INSERT INTO farm.account_sessions (id, account_id, account_version, created_at, last_seen_at, absolute_expires_at) VALUES (${'s-' + kind}, ${account}, 0, 100, 100, 10000000)`
    if (kind !== 'stranger')
      await admin`INSERT INTO farm.memberships (farm_id, account_id, role) VALUES (${farm}::uuid, ${account}, ${kind})`
  }
  await admin`INSERT INTO farm.connector_enrollments (agent_id, farm_id, public_key_spki, fingerprint) VALUES (${agent}::uuid, ${farm}::uuid, ${'A'.repeat(59)}, ${'SHA256:' + 'A'.repeat(43)})`
  await admin`UPDATE farm.connector_enrollments SET status = 'approved' WHERE agent_id = ${agent}::uuid`
  const auth = (who: keyof typeof people, farmId = farm) => ({
    sessionRecordId: 's-' + who,
    policy: { idleTimeoutMs: 1_000_000 },
    farmId,
  })
  const library = new PostgresLibrary(runtime, () => 500)
  const blobs = await createBlobStore(dir)
  const blobRows = async (hash: string) =>
    Number(
      (
        await admin`SELECT count(*)::int AS n FROM farm.library_blobs WHERE sha256 = ${hash}`
      )[0]?.n,
    )
  const version = (
    hash: string,
    size: number,
    extra: Partial<AddVersionInput> = {},
  ): AddVersionInput => ({
    sha256: hash,
    sizeBytes: size,
    location: 'connector',
    agentId: agent,
    originalName: 'benchy.gcode',
    kind: 'gcode',
    plateCount: 1,
    metadata: { slicer: 'OrcaSlicer', layerHeight: 0.2 },
    ...extra,
  })

  // --- defaults and settings authority
  const defaults = await library.getSettings(auth('viewer'))
  assert.ok(defaults.ok)
  assert.deepEqual(defaults.settings, {
    storageMode: 'connector',
    quotaBytes: 21_474_836_480,
    retentionDays: 30,
    keepVersions: null,
  })
  assert.equal(defaults.canManage, false)
  for (const who of ['viewer', 'operator'] as const)
    assert.deepEqual(
      await library.setSettings({ ...auth(who), storageMode: 'server' }),
      { ok: false, reason: 'denied' },
    )
  assert.deepEqual(await library.getSettings(auth('stranger')), {
    ok: false,
    reason: 'forbidden',
  })
  check('default-connector-mode-and-owner-admin-only-settings')

  // --- Connector mode: metadata only, dedupe by hash
  const connectorHash = sha('connector-file')
  const created = await library.addVersion({
    ...auth('operator'),
    version: version(connectorHash, 14, {
      title: 'Benchy',
      tags: ['test', 'test', ' boat '],
    }),
  })
  assert.ok(created.ok)
  assert.equal(created.version.versionNumber, 1)
  assert.equal(created.version.storageLocation, 'connector')
  assert.equal(created.version.agentId, agent)
  assert.deepEqual(created.item.tags, ['test', 'boat'])
  assert.equal(created.deduplicated, false)
  const again = await library.addVersion({
    ...auth('operator'),
    version: version(connectorHash, 14, {
      itemId: created.item.id,
      notes: 'second upload',
    }),
  })
  assert.ok(again.ok)
  assert.equal(again.version.versionNumber, 2)
  assert.equal(again.deduplicated, true)
  assert.equal(await blobRows(connectorHash), 1)
  assert.deepEqual(await files(), [], 'Connector mode writes no server blob')
  const { agentId: _unused, ...noAgent } = version(sha('x'), 1, { title: 'x' })
  assert.deepEqual(
    await library.addVersion({ ...auth('operator'), version: noAgent }),
    { ok: false, reason: 'invalid-input' },
  )
  const stray = randomUUID()
  assert.deepEqual(
    await library.addVersion({
      ...auth('operator'),
      version: version(sha('y'), 1, { title: 'y', agentId: stray }),
    }),
    { ok: false, reason: 'forbidden' },
    'Connector must be an approved enrollment of the farm',
  )
  check('connector-mode-metadata-only-and-dedupe')

  // --- Input and authority edges
  assert.deepEqual(
    await library.addVersion({
      ...auth('viewer'),
      version: version(sha('v'), 1, { title: 'v' }),
    }),
    { ok: false, reason: 'denied' },
  )
  assert.deepEqual(
    await library.addVersion({
      ...auth('operator'),
      version: version(sha('m'), 1, {
        title: 'm',
        metadata: { layerHeight: -1 },
      }),
    }),
    { ok: false, reason: 'invalid-input' },
  )
  assert.deepEqual(
    await library.addVersion({
      ...auth('operator'),
      version: version(connectorHash, 15, { itemId: created.item.id }),
    }),
    { ok: false, reason: 'invalid-input' },
    'Same hash with a different size is refused',
  )
  assert.deepEqual(
    await library.listVersions({
      ...auth('stranger'),
      itemId: created.item.id,
    }),
    { ok: false, reason: 'forbidden' },
  )
  const otherItems = await library.listItems({
    ...auth('owner'),
    farmId: otherFarm,
  })
  assert.deepEqual(otherItems, { ok: false, reason: 'forbidden' })
  check('roles-validation-and-farm-scoping')

  // --- Switch to server mode: future uploads only, history kept and reported
  const switched = await library.setSettings({
    ...auth('owner'),
    storageMode: 'server',
  })
  assert.ok(switched.ok)
  assert.equal(switched.settings.storageMode, 'server')
  assert.deepEqual(
    await library.addVersion({
      ...auth('operator'),
      version: version(sha('c2'), 2, { title: 'late' }),
    }),
    { ok: false, reason: 'mode-mismatch' },
    'A Connector-mode upload after the switch is refused',
  )

  const first = await blobs.put(bytes('server-file'))
  assert.equal(first.created, true)
  // Server mode carries no agent key at all.
  const server = (
    hash: string,
    size: number,
    extra: Partial<AddVersionInput> = {},
  ): AddVersionInput => {
    const { agentId: _agentId, ...rest } = version(hash, size, {
      location: 'server',
      ...extra,
    })
    return rest
  }
  const stored = await library.addVersion({
    ...auth('operator'),
    version: server(first.sha256, first.size, {
      itemId: created.item.id,
      kind: '3mf',
      originalName: 'benchy.3mf',
      plateCount: 2,
    }),
  })
  assert.ok(stored.ok)
  assert.equal(stored.version.storageLocation, 'server')
  assert.equal(stored.version.agentId, null)
  // Same bytes twice: one file on disk, one blob row.
  const second = await blobs.put(bytes('server-file'))
  assert.equal(second.created, false)
  const dup = await library.addVersion({
    ...auth('operator'),
    version: server(second.sha256, second.size, { itemId: created.item.id }),
  })
  assert.ok(dup.ok)
  assert.equal(dup.deduplicated, true)
  assert.equal(
    dup.orphanedServerCopy,
    false,
    'the file is the stored blob; never delete it',
  )
  assert.deepEqual(await files(), [first.sha256])
  assert.equal(await blobRows(first.sha256), 1)
  // Bytes already held by the Connector: the version keeps pointing there.
  const crossBytes = await blobs.put(bytes('connector-file'))
  const cross = await library.addVersion({
    ...auth('operator'),
    version: server(crossBytes.sha256, crossBytes.size, {
      itemId: created.item.id,
    }),
  })
  assert.ok(cross.ok)
  assert.equal(cross.version.storageLocation, 'connector')
  assert.equal(cross.orphanedServerCopy, true)
  const history = await library.listVersions({
    ...auth('viewer'),
    itemId: created.item.id,
  })
  assert.ok(history.ok)
  assert.deepEqual(
    history.versions
      .map((entry) => [entry.versionNumber, entry.storageLocation])
      .sort((a, b) => Number(a[0]) - Number(b[0])),
    [
      [1, 'connector'],
      [2, 'connector'],
      [3, 'server'],
      [4, 'server'],
      [5, 'connector'],
    ],
  )
  check('server-mode-dedupe-and-historical-locations-preserved')

  // --- Crash between write and rename leaves no visible version
  const crashHash = sha('crash-file')
  await assert.rejects(
    blobs.put(bytes('crash-file'), {
      beforeRename: () => {
        throw new Error('simulated crash')
      },
    }),
    /simulated crash/,
  )
  assert.equal(await blobs.has(crashHash), false)
  assert.ok(!(await files()).includes(crashHash))
  assert.equal(await blobRows(crashHash), 0)
  // A process that dies before the rename leaves only an invisible temp file.
  await writeFile(join(dir, '.tmp', 'leftover'), 'partial')
  assert.deepEqual(await files(), [first.sha256, crossBytes.sha256].sort())
  assert.equal(await blobs.sweepTemp(0, Date.now() + 1000), 1)
  // A crash after the rename but before the database commit: file exists, no version.
  const orphan = await blobs.put(bytes('orphan-file'))
  const listed = await library.listVersions({
    ...auth('viewer'),
    itemId: created.item.id,
  })
  assert.ok(listed.ok)
  assert.ok(!listed.versions.some((entry) => entry.sha256 === orphan.sha256))
  assert.equal(await blobRows(orphan.sha256), 0)
  // Retrying the same upload then simply adds the version.
  const retry = await library.addVersion({
    ...auth('operator'),
    version: server(orphan.sha256, orphan.size, { itemId: created.item.id }),
  })
  assert.ok(retry.ok)
  check('crash-between-write-and-rename-leaves-no-version')

  // --- Blob store: ranges, size limit, path safety
  const range = await blobs.read(
    first.sha256,
    parseRange('bytes=2-4', first.size),
  )
  assert.equal(await text(range.stream), 'rve')
  assert.deepEqual(range.range, { start: 2, end: 4 })
  assert.equal(
    await text(
      (await blobs.read(first.sha256, parseRange('bytes=-4', first.size)))
        .stream,
    ),
    'file',
  )
  assert.equal(
    await text(
      (await blobs.read(first.sha256, parseRange('bytes=7-', first.size)))
        .stream,
    ),
    'file',
  )
  assert.equal(
    await text((await blobs.read(first.sha256)).stream),
    'server-file',
  )
  for (const bad of [
    'bytes=99-100',
    'bytes=-0',
    'items=1-2',
    'bytes=5-2',
    'bytes=-',
  ])
    assert.throws(() => parseRange(bad, first.size), BlobStoreError)
  await assert.rejects(blobs.put(bytes('0123456789'), { maxBytes: 4 }), {
    code: 'too-large',
  })
  assert.deepEqual((await readdir(join(dir, '.tmp'))).length, 0)
  for (const hostile of [
    '../etc/passwd',
    '..',
    first.sha256.toUpperCase(),
    first.sha256 + '/..',
    '',
  ])
    await assert.rejects(blobs.read(hostile), { code: 'invalid-hash' })
  await assert.rejects(blobs.read(sha('missing')), { code: 'not-found' })
  // A symlink planted at a hash name is never followed.
  const outside = join(
    await mkdtemp(join(tmpdir(), 'openfarm-library-outside-')),
    'secret',
  )
  await writeFile(outside, 'secret')
  const linkHash = sha('link')
  await symlink(outside, join(dir, linkHash))
  await assert.rejects(blobs.read(linkHash), { code: 'not-found' })
  assert.equal(await blobs.has(linkHash), false)
  await rm(join(outside, '..'), { recursive: true, force: true })
  await assert.rejects(createBlobStore('relative/dir'), {
    code: 'outside-root',
  })
  await assert.rejects(createBlobStore(undefined), { code: 'outside-root' })
  check('blob-store-range-limits-and-path-safety')

  // --- Quota (server blobs only) and soft delete
  const quota = await library.setSettings({ ...auth('owner'), quotaBytes: 20 })
  assert.ok(quota.ok)
  const used = Number(
    (
      await admin`SELECT COALESCE(sum(size_bytes),0)::int AS n FROM farm.library_blobs WHERE farm_id=${farm}::uuid AND storage_location='server'`
    )[0]?.n,
  )
  const big = await blobs.put(bytes('x'.repeat(30 - used)))
  const refused = await library.addVersion({
    ...auth('operator'),
    version: server(big.sha256, big.size, { title: 'big' }),
  })
  assert.ok(!refused.ok && refused.reason === 'quota-exceeded')
  assert.match(refused.message ?? '', /Cota da biblioteca excedida/)
  assert.equal(await blobRows(big.sha256), 0)
  assert.equal(
    Number(
      (
        await admin`SELECT count(*)::int AS n FROM farm.library_items WHERE title = 'big'`
      )[0]?.n,
    ),
    0,
    'A refused upload leaves no item behind',
  )
  assert.deepEqual(
    await library.softDeleteVersion({
      ...auth('operator'),
      versionId: retry.version.id,
    }),
    { ok: false, reason: 'denied' },
  )
  const deleted = await library.softDeleteVersion({
    ...auth('owner'),
    versionId: retry.version.id,
  })
  assert.ok(deleted.ok)
  assert.deepEqual(
    await library.softDeleteVersion({
      ...auth('owner'),
      versionId: retry.version.id,
    }),
    { ok: false, reason: 'not-found' },
  )
  assert.deepEqual(
    await library.softDeleteVersion({
      ...auth('viewer'),
      versionId: first.sha256,
    }),
    { ok: false, reason: 'invalid-input' },
  )
  const visible = await library.listVersions({
    ...auth('viewer'),
    itemId: created.item.id,
  })
  const withDeleted = await library.listVersions({
    ...auth('viewer'),
    itemId: created.item.id,
    includeDeleted: true,
  })
  assert.ok(visible.ok && withDeleted.ok)
  assert.equal(withDeleted.versions.length, visible.versions.length + 1)
  assert.equal(
    withDeleted.versions.find((entry) => entry.id === retry.version.id)
      ?.deletedAt,
    500,
  )
  check('quota-and-soft-delete')

  // --- Search: filters combine, keyset paging survives inserts
  assert.ok(
    (
      await library.setSettings({
        ...auth('owner'),
        storageMode: 'connector',
        quotaBytes: 21_474_836_480,
      })
    ).ok,
  )
  const specs = [
    ['find-a', 'Voron 2.4', 0.4, 'PETG', 'OrcaSlicer'],
    ['find-b', 'Voron 2.4', 0.6, 'PLA', 'PrusaSlicer'],
    ['find-c', 'Ender 3', 0.4, 'PETG', 'PrusaSlicer'],
  ] as const
  const found: string[] = []
  for (const [title, model, nozzle, material, slicer] of specs) {
    const added = await library.addVersion({
      ...auth('operator'),
      version: version(sha(title), 7, {
        title,
        tags: [title === 'find-b' ? 'other' : 'shared'],
        originalName: title + '.gcode',
        metadata: {
          printerModel: model,
          slicer,
          tools: [{ nozzleDiameter: nozzle, filamentType: material }],
        },
      }),
    })
    assert.ok(added.ok)
    found.push(added.item.id)
  }
  const titles = async (search: Record<string, unknown>) => {
    const r = await library.searchItems({
      ...auth('viewer'),
      search: { ...search, title: 'find-' + ((search.title as string) ?? '') },
    })
    assert.ok(r.ok)
    return r.items.map((i) => i.title).sort()
  }
  assert.deepEqual(await titles({}), ['find-a', 'find-b', 'find-c'])
  assert.deepEqual(await titles({ printerModel: 'voron' }), [
    'find-a',
    'find-b',
  ])
  assert.deepEqual(await titles({ nozzle: 0.4 }), ['find-a', 'find-c'])
  assert.deepEqual(await titles({ material: 'petg' }), ['find-a', 'find-c'])
  assert.deepEqual(await titles({ slicer: 'prusa' }), ['find-b', 'find-c'])
  assert.deepEqual(await titles({ tag: 'SHARED' }), ['find-a', 'find-c'])
  assert.deepEqual(
    await titles({ printerModel: 'voron', material: 'petg', nozzle: 0.4 }),
    ['find-a'],
  )
  const pageOne = await library.searchItems({
    ...auth('viewer'),
    search: { title: 'find-' },
    limit: 2,
  })
  assert.ok(pageOne.ok && pageOne.next !== null)
  assert.ok(
    (
      await library.addVersion({
        ...auth('operator'),
        version: version(sha('find-late'), 7, {
          title: 'find-late',
          originalName: 'late.gcode',
        }),
      })
    ).ok,
  )
  const pageTwo = await library.searchItems({
    ...auth('viewer'),
    search: { title: 'find-' },
    limit: 2,
    after: pageOne.next,
  })
  assert.ok(pageTwo.ok)
  const seen = [...pageOne.items, ...pageTwo.items].map((i) => i.id)
  assert.equal(new Set(seen).size, seen.length, 'No item is repeated')
  for (const id of found) assert.ok(seen.includes(id), 'No item is skipped')
  assert.deepEqual(
    await library.searchItems({ ...auth('stranger'), search: {} }),
    { ok: false, reason: 'forbidden' },
  )
  const foundVersions = await library.listVersions({
    ...auth('viewer'),
    itemId: found[0]!,
  })
  assert.ok(foundVersions.ok && foundVersions.versions[0])
  const detail = await library.getVersion({
    ...auth('viewer'),
    versionId: foundVersions.versions[0].id,
  })
  assert.ok(detail.ok)
  assert.equal(detail.version.id, foundVersions.versions[0].id)
  assert.equal(detail.item.id, found[0])
  assert.deepEqual(
    await library.getVersion({
      ...auth('stranger'),
      versionId: foundVersions.versions[0].id,
    }),
    { ok: false, reason: 'forbidden' },
  )
  check('search-filters-and-stable-paging')

  // --- Least privilege and immutability in the database
  await assert.rejects(runtime`DELETE FROM farm.library_versions`)
  await assert.rejects(
    runtime`UPDATE farm.library_versions SET sha256 = ${sha('z')}`,
  )
  await assert.rejects(runtime`UPDATE farm.library_blobs SET size_bytes = 1`)
  await assert.rejects(admin`UPDATE farm.library_versions SET size_bytes = 1`)
  await assert.rejects(admin`TRUNCATE farm.library_blobs`)
  await assert.rejects(
    runtime`INSERT INTO farm.farms (id) VALUES (${randomUUID()}::uuid)`,
  )
  await assert.rejects(
    admin`INSERT INTO farm.library_versions (id, farm_id, item_id, version_number, sha256, size_bytes, storage_location, original_name, kind, uploaded_by, created_at)
      VALUES (${randomUUID()}::uuid, ${farm}::uuid, ${created.item.id}::uuid, 99, ${sha('nope')}, 1, 'server', 'a.gcode', 'gcode', 'x', 1)`,
    /foreign key/,
  )
  check('least-privilege-and-immutable-rows')
} finally {
  try {
    await runtime.end({ timeout: 3 })
  } finally {
    try {
      if (roleCreated) await admin`DROP ROLE ${admin(role)}`
    } finally {
      try {
        await admin.end({ timeout: 3 })
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  }
}
console.log(JSON.stringify({ result: 'passed', checks }))
