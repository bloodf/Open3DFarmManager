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
    if (name.startsWith('GIT_') || name === 'ORQ_BASE_SHA') {
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

function plan(root: string, base: string) {
  const result = checks(root, ['plan', 'unit', base])
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

test('the base falls back to ORQ_BASE_SHA and an unknown base fails', (t) => {
  const { root, base } = fixture(t)
  commit(root, { 'README.md': 'two\n' })
  const fallback = checks(root, ['plan', 'unit'], { ORQ_BASE_SHA: base })
  assert.equal(fallback.status, 0, fallback.stderr)
  assert.match(fallback.stdout, /prettier .*README\.md/)

  const unknown = checks(root, ['plan', 'unit', 'no-such-ref'])
  assert.equal(unknown.status, 2)
  assert.match(unknown.stderr, /unknown base/)
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
