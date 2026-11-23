import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sandboxState } from '../../scripts/sandbox-support.ts'
import {
  catalogThrough,
  loadMigrationCatalog,
  runMigrations,
} from '../../scripts/db/migrations.ts'
import {
  disposablePostgres,
  findPostgresBin,
} from '../helpers/disposable-postgres.ts'
import postgres from 'postgres'

let missing = ''
try {
  findPostgresBin()
} catch (error) {
  missing = String(error)
}
if (missing && process.env.CI) throw new Error(missing)
if (missing) console.warn(`SKIP sandbox lifecycle: ${missing}`)

test(
  'launcher advances an old journal, aborts a failed migration, and retries',
  { timeout: 120_000, skip: missing || false },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'sandbox-launch-test-'))
    const previousProvider = process.env.OPENFARM_PG
    delete process.env.OPENFARM_PG
    const pg = disposablePostgres({
      name: 'sandbox-launch-716',
      isolated: true,
      through: false,
      additionalScramRoles: ['sandbox_bootstrap'],
    })
    if (previousProvider !== undefined)
      process.env.OPENFARM_PG = previousProvider
    let sql: ReturnType<typeof postgres> | undefined
    try {
      const admin = await pg.start()
      await admin.unsafe(
        `CREATE ROLE sandbox_bootstrap LOGIN SUPERUSER PASSWORD '${pg.password}'`,
      )
      await admin`CREATE DATABASE sandbox OWNER sandbox_bootstrap`
      sql = postgres({
        host: '127.0.0.1',
        port: pg.port,
        database: 'sandbox',
        username: 'sandbox_bootstrap',
        password: pg.password,
        ssl: false,
        max: 1,
      })
      const catalog = await loadMigrationCatalog()
      await runMigrations(sql, catalogThrough(catalog, '0092_resin_ledger'), {
        kind: 'up',
      })
      const before =
        await sql`SELECT id, checksum FROM public.open3dfarm_migrations ORDER BY position`
      const legacy =
        'o3dfm-sandbox-' +
        createHash('sha256').update(process.cwd()).digest('hex').slice(0, 12)
      const state = sandboxState(legacy, process.getuid!(), {
        XDG_STATE_HOME: root,
      })
      mkdirSync(state, { recursive: true, mode: 0o700 })
      writeFileSync(join(state, 'client.json'), '{"clientId":"preserved"}')
      writeFileSync(join(state, 'db-password'), pg.password)
      const bin = join(root, 'bin')
      mkdirSync(bin)
      const log = join(root, 'calls')
      writeFileSync(
        join(bin, 'docker'),
        `#!/bin/sh
if [ "$1 $2" = "volume ls" ]; then exit 0; fi
printf '%s\\n' "$*" >> "$FAKE_LOG"
case "$*" in *"port postgres 5432"*) printf '127.0.0.1:%s\\n' "$PGPORT";; *"bambu app connector"*) exit 42;; esac
`,
        { mode: 0o755 },
      )
      writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      writeFileSync(join(bin, 'npx'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      const launch = () => {
        try {
          execFileSync(process.execPath, ['scripts/sandbox.ts'], {
            env: {
              ...process.env,
              XDG_STATE_HOME: root,
              DOCKER_HOST: 'unix:///fixture',
              PATH: `${bin}:${process.env.PATH}`,
              PGPORT: String(pg.port),
              FAKE_LOG: log,
            },
            stdio: 'pipe',
          })
          assert.fail('expected failure')
        } catch (error) {
          return String((error as { stderr?: Buffer }).stderr ?? error)
        }
      }
      const [constraint] =
        await sql`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'farm.pause_authority_challenges'::regclass AND conname = 'control_capability_actions'`
      await sql`ALTER TABLE farm.pause_authority_challenges DROP CONSTRAINT control_capability_actions`
      assert.match(launch(), /Falha ao aplicar migrações/)
      assert.doesNotMatch(readFileSync(log, 'utf8'), /bambu app connector/)
      assert.equal(
        (
          await sql`SELECT count(*)::int AS count FROM public.open3dfarm_migrations`
        )[0]!.count,
        before.length,
      )
      await sql.unsafe(
        `ALTER TABLE farm.pause_authority_challenges ADD CONSTRAINT control_capability_actions ${constraint!.definition}`,
      )
      // Fake Compose intentionally stops at app startup after recording progress.
      launch()
      assert.match(readFileSync(log, 'utf8'), /bambu app connector/)
      const after =
        await sql`SELECT id, checksum FROM public.open3dfarm_migrations ORDER BY position`
      assert.equal(after.length, catalog.length)
      assert.deepEqual(
        after.map((row) => row.id),
        catalog.map((entry) => entry.id),
      )
      assert.deepEqual(after.slice(0, before.length), Array.from(before))
      assert.equal(
        readFileSync(join(state, 'client.json'), 'utf8'),
        '{"clientId":"preserved"}',
      )
    } finally {
      await sql?.end()
      await pg.stop()
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test('fake Compose isolates state homes and adopts only the legacy project with matching runtime mount', () => {
  const root = mkdtempSync(join(tmpdir(), 'sandbox-compose-test-'))
  try {
    const bin = join(root, 'bin')
    mkdirSync(bin)
    const log = join(root, 'calls')
    writeFileSync(
      join(bin, 'docker'),
      `#!/bin/sh
if [ "$1 $2" = "volume ls" ]; then printf '%s' "$FAKE_VOLUME"; exit 0; fi
if [ "$1 $2" = "volume inspect" ]; then printf '%s' "$FAKE_INSPECT"; exit 0; fi
printf '%s\\n' "$*" >> "$FAKE_LOG"
`,
      { mode: 0o755 },
    )
    const legacy =
      'o3dfm-sandbox-' +
      createHash('sha256').update(process.cwd()).digest('hex').slice(0, 12)
    const homeA = join(root, 'a')
    const homeB = join(root, 'b')
    const stateA = sandboxState(legacy, process.getuid!(), {
      XDG_STATE_HOME: homeA,
    })
    mkdirSync(join(stateA, 'database'), { recursive: true, mode: 0o700 })
    const inspect = JSON.stringify([
      {
        Name: `${legacy}_database`,
        Driver: 'local',
        Labels: {
          'com.docker.compose.project': legacy,
          'com.docker.compose.volume': 'database',
        },
        Options: { type: 'none', o: 'bind', device: join(stateA, 'database') },
      },
    ])
    for (const name of ['openssl', 'npm', 'npx'])
      writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const run = (home: string, action = 'stop') =>
      execFileSync(
        process.execPath,
        ['scripts/sandbox.ts', ...(action ? [action] : [])],
        {
          env: {
            ...process.env,
            XDG_STATE_HOME: home,
            DOCKER_HOST: 'unix:///fixture',
            PATH: `${bin}:${process.env.PATH}`,
            FAKE_LOG: log,
            FAKE_VOLUME: `${legacy}_database`,
            FAKE_INSPECT: inspect,
          },
        },
      )
    run(homeA)
    assert.throws(() => run(homeB, ''), /Command failed/)
    const calls = readFileSync(log, 'utf8').trim().split('\n')
    assert.match(calls[0]!, new RegExp(`-p ${legacy} `))
    const scopedB =
      'o3dfm-sandbox-state-' +
      createHash('sha256')
        .update(
          sandboxState(legacy, process.getuid!(), { XDG_STATE_HOME: homeB }),
        )
        .digest('hex')
        .slice(0, 12)
    assert.match(calls[1]!, new RegExp(`-p ${scopedB} .*down --volumes`))
    assert.match(calls[2]!, new RegExp(`-p ${scopedB} .*up .*postgres klipper`))
    assert.match(calls[3]!, new RegExp(`-p ${scopedB} .*port postgres 5432`))
    assert.notEqual(scopedB, legacy)
    const stateB = sandboxState(legacy, process.getuid!(), {
      XDG_STATE_HOME: homeB,
    })
    rmSync(join(stateB, 'database'), { recursive: true })
    symlinkSync(join(stateA, 'database'), join(stateB, 'database'))
    assert.throws(() => run(homeB), /Command failed/)
    assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 4)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
