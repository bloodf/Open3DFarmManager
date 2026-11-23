// Spoolman v0.27.1 client-contract and upstream parity harness (#546, #548, #542).
//
// Replays the recorded Moonraker, Klipper macro, OrcaSlicer, OctoPrint and Home
// Assistant client contracts and the upstream endpoint/websocket suite against
// BOTH the pinned real Spoolman container and the built-in server, compares the
// normalised answers and fails on any difference that is not listed in
// tests/contract/spoolman-parity/allowed-differences.json (and documented in
// docs/compatibility/spoolman-matrix.md).
//
// Docker only: the pinned Spoolman image (by digest, from
// third_party/spoolman-reference/upstream.lock.json) and a disposable PostgreSQL
// container for the built-in server. Images are pulled by digest when absent;
// if that fails the run stops with a clear message. Both kinds of container are
// removed when the run ends. Nothing touches printers or host services.
//
//   node scripts/test-spoolman-parity.mjs
//
// Optional: SPOOLMAN_PARITY_EVIDENCE_DIR (report + ledger, outside the repo),
// SPOOLMAN_PARITY_RECORD=1 (rewrite docs/compatibility/spoolman-parity.json).
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { disposablePostgres } from '../tests/helpers/disposable-postgres.ts'
import { startBuiltin } from '../tests/contract/spoolman-parity/builtin.mjs'
import {
  OWNER_LABEL,
  TASK,
  docker,
  ensureImage,
  removeContainers,
} from '../tests/contract/spoolman-parity/docker.mjs'
import {
  checkAllowancesDocumented,
  loadAllowances,
  runParity,
} from '../tests/contract/spoolman-parity/index.mjs'
import { loadCorpora } from '../tests/contract/spoolman-parity/corpora.mjs'
import { startUpstream } from '../tests/contract/spoolman-parity/upstream.mjs'

if (process.argv.length !== 2)
  throw new Error(
    'No arguments accepted: node scripts/test-spoolman-parity.mjs',
  )

const repoRoot = resolve(fileURLToPath(new URL('../', import.meta.url)))
const MIGRATION = '0089_spool_features_schema'
// postgres:17 pinned by digest (pulled by digest when it is not local yet).
const POSTGRES_IMAGE =
  'postgres:17@sha256:f4c66b820c6f974249089d3d16d86a3698eae11e8746eb6644b2271031e91232'
const lock = JSON.parse(
  await readFile(
    join(repoRoot, 'third_party/spoolman-reference/upstream.lock.json'),
    'utf8',
  ),
)
const SPOOLMAN_IMAGE = `ghcr.io/donkie/spoolman@${lock.upstream.image_digest}`

const evidenceDir = resolve(
  process.env.SPOOLMAN_PARITY_EVIDENCE_DIR ??
    (await mkdtemp(join(tmpdir(), 'o3dfm-spoolman-parity-'))),
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

const endpoint =
  process.env.DOCKER_HOST ??
  (await docker('context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'))
assert.match(endpoint, /^unix:\/\//, 'Only a local Docker daemon is allowed')

const created = []
let fixtureServer
let builtin
let pg
let failed = false
const containerPrefix = `o3dfm-parity-546-pg-${randomBytes(3).toString('hex')}`

try {
  const pulls = {
    spoolman: await ensureImage(SPOOLMAN_IMAGE, 'Spoolman v0.27.1 reference'),
    postgres: await ensureImage(POSTGRES_IMAGE, 'PostgreSQL 17'),
  }
  const spoolmanImageId = await docker(
    'image',
    'inspect',
    '--format',
    '{{.Id}}',
    SPOOLMAN_IMAGE,
  )
  ledger({ images: { SPOOLMAN_IMAGE, POSTGRES_IMAGE, spoolmanImageId, pulls } })

  const allowances = await loadAllowances()
  const matrixMd = await readFile(
    join(repoRoot, 'docs/compatibility/spoolman-matrix.md'),
    'utf8',
  )
  const undocumented = await checkAllowancesDocumented(allowances, matrixMd)
  assert.deepEqual(undocumented, [], 'undocumented allowed differences')

  const corpora = await loadCorpora()

  // Loopback fixture server for the built-in server's external library.
  const fixtureDir = join(repoRoot, 'tests/fixtures/spoolman/aux')
  fixtureServer = createServer(async (req, res) => {
    const name = (req.url ?? '').replace(/^\//, '')
    if (name !== 'filaments.json' && name !== 'materials.json') {
      res.statusCode = 404
      res.end()
      return
    }
    res.setHeader('Content-Type', 'application/json')
    res.end(await readFile(join(fixtureDir, name)))
  })
  await new Promise((done) => fixtureServer.listen(0, '127.0.0.1', done))
  const externalUrl = `http://127.0.0.1:${fixtureServer.address().port}/`

  // Spoolman containers (one per corpus) start while PostgreSQL comes up.
  process.env.OPENFARM_PG = 'docker'
  pg = disposablePostgres({
    name: containerPrefix,
    labelKey: OWNER_LABEL,
    labelValue: TASK,
    docker,
    image: POSTGRES_IMAGE,
    ledger,
    through: MIGRATION,
  })
  created.push(containerPrefix)
  const [admin, upstreams] = await Promise.all([
    pg.start(),
    Promise.all(
      corpora.map((corpus) =>
        startUpstream({
          image: SPOOLMAN_IMAGE,
          label: corpus.name,
          externalFixtureDir: corpus.external ? fixtureDir : undefined,
          created,
        }),
      ),
    ),
  ])
  builtin = await startBuiltin({
    pgPort: pg.port,
    pgPassword: pg.password,
    admin,
    externalUrl,
  })
  const pairs = new Map()
  for (const [index, corpus] of corpora.entries())
    pairs.set(corpus.name, {
      upstream: upstreams[index],
      builtin: await builtin.target(index),
    })
  const info = await (await fetch(`${upstreams[0].baseUrl}/api/v1/info`)).json()
  assert.equal(info.version, '0.27.1', 'running image is not Spoolman 0.27.1')
  ledger({ spoolmanInfo: info, containers: created })

  const { report, failures } = await runParity({ corpora, pairs, allowances })

  const record = {
    id: 'spoolman-parity-record',
    issues: [546, 548, 542],
    upstream: {
      project: 'Spoolman',
      version: info.version,
      version_tag: lock.upstream.version_tag,
      source_revision: lock.upstream.source_revision,
      image_digest: lock.upstream.image_digest,
      lock_file: 'third_party/spoolman-reference/upstream.lock.json',
    },
    builtin: {
      postgres_image: POSTGRES_IMAGE,
      migration: MIGRATION,
    },
    allowed_differences_sha256: createHash('sha256')
      .update(
        await readFile(
          join(
            repoRoot,
            'tests/contract/spoolman-parity/allowed-differences.json',
          ),
        ),
      )
      .digest('hex'),
    corpora: report.map(({ corpus, kind, files, total, outcomes }) => ({
      corpus,
      kind,
      files,
      total,
      outcomes,
    })),
  }
  const recordPath = join(repoRoot, 'docs/compatibility/spoolman-parity.json')
  await writeFile(
    join(evidenceDir, 'report.json'),
    JSON.stringify({ ...record, results: report }, null, 2) + '\n',
  )
  if (process.env.SPOOLMAN_PARITY_RECORD === '1')
    await writeFile(recordPath, JSON.stringify(record, null, 2) + '\n')
  else {
    const committed = await readFile(recordPath, 'utf8').catch(() => undefined)
    if (committed === undefined)
      failures.push(
        'docs/compatibility/spoolman-parity.json is missing: run with SPOOLMAN_PARITY_RECORD=1',
      )
    else if (JSON.stringify(JSON.parse(committed)) !== JSON.stringify(record))
      failures.push(
        'docs/compatibility/spoolman-parity.json is stale (fixtures, allowances or outcomes changed): rerun with SPOOLMAN_PARITY_RECORD=1',
      )
  }

  if (failures.length) {
    failed = true
    console.error(`\n${failures.length} unexplained difference(s):\n`)
    for (const failure of failures) console.error(`- ${failure}\n`)
  } else {
    console.log(
      `\nparity: ${report.reduce((n, r) => n + r.total, 0)} cases identical or explained; report ${join(evidenceDir, 'report.json')}`,
    )
  }
} catch (error) {
  failed = true
  console.error(
    `FAILED: ${(error instanceof Error ? (error.stack ?? error.message) : String(error)).slice(0, 6000)}`,
  )
} finally {
  await builtin?.close().catch(() => {})
  await new Promise((done) =>
    fixtureServer ? fixtureServer.close(done) : done(),
  )
  try {
    await pg?.stop()
  } catch (error) {
    console.error(
      `PostgreSQL stop reported: ${String(error).split('\n', 1)[0]}`,
    )
  }
  const remaining = await removeContainers(created)
  ledger({ cleanup: created, remaining })
  if (remaining.length) {
    failed = true
    console.error(`Cleanup incomplete: ${remaining.join('; ')}`)
  } else console.log(`Cleanup: ${created.length} container(s) removed`)
}
process.exitCode = failed ? 1 : 0
