// E16-370: the README "Rodar no desktop" section and docs/DESKTOP.md.
// Static checks keep the documented commands and paths real. Runtime checks run
// the README's own commands: the desktop:check list, preflight, the Docker
// opt-out switches, the offline deps report, the mock simulator smoke and the
// built-app smoke (needs `npm run build` first; it fails, not skips, without it).
// Never sends printer commands; no network is used except loopback.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createServer } from 'node:net'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (path) => readFileSync(join(ROOT, path), 'utf8')
const readme = read('README.md')
const guide = read('docs/DESKTOP.md')
const pkg = JSON.parse(read('package.json'))

const start = readme.indexOf('## Rodar no desktop')
const end = readme.indexOf('## Como as peças se conectam')
const section = start >= 0 && end > start ? readme.slice(start, end) : ''
const docs = `${section}\n${guide}`

const npmScripts = (text) =>
  [...text.matchAll(/npm run ([\w:.-]+)/g)].map((match) => match[1])

function run(command, args, options = {}) {
  const env = { ...process.env, ...options.env }
  for (const name of options.unset ?? []) delete env[name]
  return spawnSync(command, args, {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: options.timeout ?? 120_000,
  })
}

test('README section exists, links the guide and keeps npm (no pnpm)', () => {
  assert.ok(
    section.length > 0,
    'README has "## Rodar no desktop" before "Como as peças"',
  )
  assert.match(section, /docs\/DESKTOP\.md/)
  assert.doesNotMatch(section, /pnpm/i)
  assert.match(section, /npm ci --ignore-scripts/)
  assert.match(section, /Docker[^.]*opt-in/)
})

// The orchestrator gate runs this file in a tree without node_modules, so the
// README's own first command is exercised here: install when absent.
const installed = () =>
  existsSync(join(ROOT, 'node_modules/.package-lock.json'))

test(
  'README step 1: npm ci --ignore-scripts leaves a usable install',
  { timeout: 600_000 },
  () => {
    if (!installed()) {
      const install = run('npm', ['ci', '--ignore-scripts'], {
        timeout: 540_000,
      })
      assert.equal(install.status, 0, install.stdout + install.stderr)
    }
    assert.ok(installed(), 'node_modules is installed')
    assert.ok(
      existsSync(join(ROOT, 'node_modules/.bin/nuxt')),
      'nuxt is installed',
    )
  },
)

test('every "npm run" script named in the section and guide exists in package.json', () => {
  const names = [...new Set(npmScripts(docs))]
  assert.ok(names.length >= 5, `expected documented scripts, got ${names}`)
  for (const name of names)
    assert.ok(pkg.scripts[name], `package.json has script "${name}"`)
})

test('every node script path named in the section and guide exists', () => {
  const paths = [
    ...docs.matchAll(/node ((?:scripts|tests|packages)\/[\w./-]+)/g),
  ].map((match) => match[1])
  assert.ok(paths.length >= 1, `expected script paths, got ${paths}`)
  for (const path of new Set(paths))
    assert.ok(existsSync(join(ROOT, path)), `${path} exists`)
})

test('the documented desktop:check steps and switches exist in the check', () => {
  const list = run(process.execPath, ['scripts/desktop-check.ts', '--list'])
  assert.equal(list.status, 0, list.stderr)
  for (const step of ['preflight', 'lint', 'build', 'test-e2e', 'app-smoke'])
    assert.match(list.stdout, new RegExp(`^${step}\\s`, 'm'), `step ${step}`)
  assert.match(guide, /--only app-smoke/)
  assert.match(guide, /--skip test-e2e/)
  assert.match(guide, /--require-isolated-network/)
  assert.match(guide, /OPENFARM_SIM/)
  assert.match(guide, /OPENFARM_PG/)
})

test('npm run desktop:check -- --list (README form) lists the steps', () => {
  const list = run('npm', ['run', '--silent', 'desktop:check', '--', '--list'])
  assert.equal(list.status, 0, list.stderr)
  assert.match(list.stdout, /^app-smoke\s/m)
})

test('preflight passes on this host and writes a receipt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'e16-370-receipt-'))
  try {
    const receipt = join(dir, 'receipt.json')
    const result = run(
      process.execPath,
      ['scripts/desktop-check.ts', '--only', 'preflight', '--receipt', receipt],
      { unset: ['DOCKER_HOST', 'OPENFARM_SIM', 'OPENFARM_PG'] },
    )
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const json = JSON.parse(readFileSync(receipt, 'utf8'))
    assert.equal(json.result, 'passed')
    assert.equal(json.steps[0].name, 'preflight')
    assert.equal(json.steps[0].status, 'passed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

for (const name of ['OPENFARM_SIM', 'OPENFARM_PG']) {
  test(`${name}=docker is refused by the desktop check (opt-in only)`, () => {
    const result = run(
      process.execPath,
      ['scripts/desktop-check.ts', '--only', 'preflight'],
      {
        env: { [name]: 'docker' },
        unset: ['DOCKER_HOST'],
      },
    )
    assert.equal(result.status, 1, result.stdout)
    assert.match(
      result.stdout,
      new RegExp(`${name}=docker: Docker or bundled browsers are not allowed`),
    )
  })
}

const freePort = () =>
  new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolvePort(port))
    })
  })

test(
  'section database commands: initdb, pg_ctl start, createdb and the NUXT URL connect on loopback',
  { timeout: 300_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'e16-370-pg-'))
    const pgdata = join(dir, 'pgdata')
    const port = await freePort()
    let started = false
    try {
      const init = run(
        'initdb',
        ['-D', pgdata, '-U', 'openfarm', '--auth=trust'],
        { timeout: 180_000 },
      )
      assert.equal(init.status, 0, init.stdout + init.stderr)
      const start = run(
        'pg_ctl',
        [
          '-D',
          pgdata,
          '-o',
          `-h 127.0.0.1 -p ${port}`,
          '-l',
          join(pgdata, 'server.log'),
          'start',
        ],
        { timeout: 120_000 },
      )
      assert.equal(start.status, 0, start.stdout + start.stderr)
      started = true
      const create = run('createdb', [
        '-h',
        '127.0.0.1',
        '-p',
        String(port),
        '-U',
        'openfarm',
        'openfarm',
      ])
      assert.equal(create.status, 0, create.stdout + create.stderr)
      const url = `postgres://openfarm@127.0.0.1:${port}/openfarm`
      const { default: postgres } = await import('postgres')
      const sql = postgres(url, { max: 1, connect_timeout: 5 })
      try {
        const [row] =
          await sql`select current_database() as db, current_setting('server_version_num')::int >= 170000 as ok`
        assert.equal(row.db, 'openfarm')
        assert.equal(row.ok, true, 'PostgreSQL 17 or newer')
      } finally {
        await sql.end()
      }
    } finally {
      if (started)
        run('pg_ctl', ['-D', pgdata, '-m', 'fast', 'stop'], { timeout: 60_000 })
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

test('desktop-deps-report reads the lockfile offline', () => {
  const result = run(process.execPath, ['scripts/desktop-deps-report.mjs'])
  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.stdout.trim().length > 0, 'report prints output')
})

test('npm run sim:smoke passes against the in-process mocks (default OPENFARM_SIM)', () => {
  const result = run('npm', ['run', '--silent', 'sim:smoke'], {
    env: { OPENFARM_SIM: 'mock' },
    timeout: 300_000,
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})

test(
  'npm run desktop:check -- --only app-smoke: built app, Connector and farm page on mocks',
  { timeout: 900_000 },
  () => {
    if (!existsSync(join(ROOT, 'apps/farm/.output/server/index.mjs'))) {
      const build = run('npm', ['run', '--silent', 'build'], {
        timeout: 900_000,
      })
      assert.equal(build.status, 0, build.stdout + build.stderr)
    }
    const dir = mkdtempSync(join(tmpdir(), 'e16-370-smoke-'))
    try {
      const result = run(
        'npm',
        [
          'run',
          '--silent',
          'desktop:check',
          '--',
          '--only',
          'app-smoke',
          '--receipt',
          join(dir, 'r.json'),
        ],
        {
          timeout: 900_000,
        },
      )
      assert.equal(result.status, 0, result.stdout + result.stderr)
      const json = JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8'))
      assert.equal(json.result, 'passed')
      assert.equal(
        json.steps.find((step) => step.name === 'app-smoke')?.status,
        'passed',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)
