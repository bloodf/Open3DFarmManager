import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(
  new URL('../../scripts/checks.sh', import.meta.url),
)

function environment(extra: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_') || name.startsWith('ORQ_')) {
      if (!(name in extra)) delete env[name]
    }
  }
  return env
}

function write(root: string, path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), content)
}

function git(root: string, ...args: string[]) {
  return execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args],
    { cwd: root, encoding: 'utf8', env: environment() },
  ).trim()
}

function commit(root: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    write(root, path, content)
  }
  git(root, 'add', '-A')
  git(root, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'change')
  return git(root, 'rev-parse', 'HEAD')
}

const util = 'apps/farm/app/utils/format.ts'
const importer = 'tests/node/format.test.ts'

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'checks-script-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  git(root, 'init', '-q')
  const base = commit(root, {
    'README.md': 'one\n',
    [util]: 'export const a = 1\n',
    [importer]: `import { a } from '../../${util}'\n`,
    'tests/node/other.test.ts': `import '../../apps/farm/app/utils/other.ts'\n`,
    'tools/rtsp-ingest/main.go': 'package main\n',
  })
  return { root, base }
}

function checks(
  root: string,
  args: string[],
  extra: Record<string, string> = {},
) {
  return spawnSync('sh', [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: environment(extra),
  })
}

function plan(root: string, base: string, extra: Record<string, string> = {}) {
  const result = checks(root, ['plan', 'unit', base], extra)
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.split('\n').filter(Boolean)
}

const nodeFlags =
  'node --test --test-concurrency=1 --test-timeout=120000 --test-force-exit'
const vitestRelated =
  'npx vitest related --run --maxWorkers=50% --passWithNoTests'

test('a docs-only change runs prettier only', (t) => {
  const { root, base } = fixture(t)
  commit(root, {
    'README.md': 'two\n',
    'tools/rtsp-ingest/README.md': 'notes\n',
  })
  assert.deepEqual(plan(root, base), [
    'npx prettier --check --ignore-unknown -- README.md tools/rtsp-ingest/README.md',
  ])
})

test('an app util runs typecheck, related Vitest and importing node tests', (t) => {
  const { root, base } = fixture(t)
  commit(root, { [util]: 'export const a = 2\n' })
  assert.deepEqual(plan(root, base), [
    `npx prettier --check --ignore-unknown -- ${util}`,
    'npm run typecheck',
    `${vitestRelated} ${util}`,
    `${nodeFlags} ${importer}`,
  ])
})

test('component files are hex linted and bracketed names stay literal', (t) => {
  const { root, base } = fixture(t)
  const page = 'apps/farm/app/components/[id].vue'
  commit(root, { [page]: '<template><p /></template>\n' })
  const lines = plan(root, base)
  assert.ok(
    lines.includes(`node apps/farm/app/assets/lint-hex-colours.mjs ${page}`),
  )
  assert.ok(lines.includes(`${vitestRelated} ${page}`))
})

test('changed node tests and package importers are selected once', (t) => {
  const { root, base } = fixture(t)
  commit(root, {
    'packages/shared/src/id.ts': 'export {}\n',
    'tests/node/by-name.test.ts': `import '@open3dfarmmanager/shared'\n`,
  })
  assert.ok(
    plan(root, base).includes(`${nodeFlags} tests/node/by-name.test.ts`),
  )
})

test('an rtsp-ingest change runs the Go tests', (t) => {
  const { root, base } = fixture(t)
  commit(root, { 'tools/rtsp-ingest/main.go': 'package main // x\n' })
  const lines = plan(root, base)
  assert.ok(lines.includes('npm run test:go'))
  assert.ok(!lines.includes('npm run typecheck'))
})

test('the base falls back to ORQ_BASE_SHA and an unknown base runs the full unit suite', (t) => {
  const { root, base } = fixture(t)
  commit(root, { 'README.md': 'two\n' })
  const fallback = checks(root, ['plan', 'unit'], { ORQ_BASE_SHA: base })
  assert.equal(fallback.status, 0, fallback.stderr)
  assert.match(fallback.stdout, /prettier .*README\.md/)

  const unknown = checks(root, ['plan', 'unit', 'no-such-ref'])
  assert.equal(unknown.status, 0, unknown.stderr)
  assertFullUnitPlan(unknown.stdout.trim().split('\n'))
  assert.match(unknown.stderr, /unknown base/)
})

function assertFullUnitPlan(lines: string[]) {
  assert.ok(lines.includes('npm run typecheck'))
  assert.ok(lines.includes('npx vitest run --maxWorkers=50%'))
  assert.ok(lines.includes('npm run test:node'))
  assert.ok(!lines.some((line) => line.startsWith(vitestRelated)))
  assert.ok(!lines.some((line) => line.startsWith(nodeFlags)))
}

test('transitive imports select node tests and extra test:node entry points', (t) => {
  const { root } = fixture(t)
  const idle = 'packages/connector/src/moonraker/console-idle.ts'
  const driver = 'packages/connector/src/moonraker/pause-driver.ts'
  const nodeTest = 'tests/node/pause-driver.test.ts'
  const extraTest = 'tests/helpers/extra.test.mts'
  const base = commit(root, {
    [idle]: "import './pause-driver.ts'\n",
    [driver]: "export * from './console-idle.js'\n",
    [nodeTest]: `import '../../${driver}'\n`,
    [extraTest]: `await import('../../${driver}')\n`,
    'package.json': JSON.stringify({
      scripts: { 'test:node': `node --test tests/node/*.test.ts ${extraTest}` },
    }),
  })
  commit(root, {
    [idle]: "import './pause-driver.ts'\nexport const idle = true\n",
  })
  assert.ok(plan(root, base).includes(`${nodeFlags} ${extraTest} ${nodeTest}`))
})

test('fixtures select node and Vitest tests by path or basename', (t) => {
  const { root } = fixture(t)
  const data = 'tests/fixtures/example.data'
  const job = 'samples/example.gcode.gz'
  const nodeTest = 'tests/node/fixture.test.ts'
  const unitTest = 'tests/unit/job.test.ts'
  const base = commit(root, {
    [data]: 'old\n',
    [job]: 'old\n',
    [nodeTest]: `const fixture = '${data}'\n`,
    [unitTest]: "const fixture = 'example.gcode.gz'\n",
  })
  commit(root, { [data]: 'new\n', [job]: 'new\n' })
  const lines = plan(root, base)
  assert.ok(lines.includes(`${nodeFlags} ${nodeTest}`))
  assert.ok(lines.includes(`npx vitest run --maxWorkers=50% ${unitTest}`))
})

test('migrations select referencing tests and the PostgreSQL suite', (t) => {
  const { root } = fixture(t)
  const migration = 'infra/db/migrations/001.sql'
  const nodeTest = 'tests/node/migration.test.ts'
  const unitTest = 'tests/unit/migration.test.ts'
  const base = commit(root, {
    [migration]: 'select 1;\n',
    [nodeTest]: "const dir = 'infra/db/migrations'\n",
    [unitTest]: `const migration = '${migration}'\n`,
  })
  commit(root, { [migration]: 'select 2;\n' })
  const expected = [
    `npx vitest run --maxWorkers=50% ${unitTest}`,
    `${nodeFlags} ${nodeTest}`,
  ]
  assert.deepEqual(plan(root, base).slice(1), expected)
  write(root, 'scripts/test-postgres.ts', 'export {}\n')
  assert.deepEqual(plan(root, base).slice(1), [
    ...expected,
    'npm run test:postgres',
  ])
})

test('a Git deletion runs the full unit suite', (t) => {
  const { root, base } = fixture(t)
  rmSync(join(root, util))
  commit(root, {})
  assertFullUnitPlan(plan(root, base))
})

test('orq change lists override Git and work with an unknown base', (t) => {
  const { root, base } = fixture(t)
  commit(root, { 'README.md': 'two\n' })
  write(root, 'changed.list', `${util}\n`)
  write(root, 'deleted.list', '')
  const extra = {
    ORQ_CHANGED_FILES: 'changed.list',
    ORQ_DELETED_FILES: 'deleted.list',
  }
  for (const ref of [base, 'no-such-ref']) {
    const lines = plan(root, ref, extra)
    assert.ok(lines.includes(`${nodeFlags} ${importer}`))
    assert.ok(!lines.some((line) => line.includes('README.md')))
  }

  write(root, 'deleted.list', 'removed.ts\n')
  assertFullUnitPlan(plan(root, 'no-such-ref', extra))
})

test('final runs the full suite and at most two Playwright workers', (t) => {
  const { root } = fixture(t)
  const result = checks(root, ['plan', 'final'])
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.stdout.trim().split('\n'), [
    'npm run lint',
    'npm run typecheck',
    'npx vitest run --maxWorkers=50%',
    'npm run test:node',
    'npm run test:go',
    'npm run test:rtsp-supervisor',
    'npm run test:rtsp-framing',
    'npm run build',
    'npx playwright test --workers=2',
  ])
})

test('every step runs after a failure and the run TMPDIR is removed', (t) => {
  const { root } = fixture(t)
  const sandbox = mkdtempSync(join(tmpdir(), 'checks-stubs-'))
  t.after(() => rmSync(sandbox, { recursive: true, force: true }))
  const log = join(sandbox, 'log')
  for (const name of ['npm', 'npx']) {
    write(
      sandbox,
      `bin/${name}`,
      `#!/bin/sh\necho "$TMPDIR ${name} $*" >> '${log}'\n[ "$*" != 'run lint' ]\n`,
    )
    chmodSync(join(sandbox, 'bin', name), 0o755)
  }
  const cache = join(sandbox, 'cache')
  const result = checks(root, ['final'], {
    PATH: `${join(sandbox, 'bin')}:${process.env.PATH}`,
    HOME: sandbox,
    XDG_CACHE_HOME: cache,
  })

  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stdout, /Failed steps:\nlint\n$/)
  const calls = readFileSync(log, 'utf8').trim().split('\n')
  assert.equal(calls.length, 9)
  assert.ok(calls.every((line) => line.startsWith(`${cache}/openfarm-checks/`)))
  assert.deepEqual(readdirSync(join(cache, 'openfarm-checks')), [])
})
