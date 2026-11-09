import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const gate = join(root, 'scripts/vercel-ignore.mjs')

test('Vercel config and real Git history enforce main and changed inputs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'open3d-vercel-gate-'))
  const repo = join(dir, 'repo')
  mkdirSync(repo)
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Gate test',
    GIT_AUTHOR_EMAIL: 'gate@example.invalid',
    GIT_COMMITTER_NAME: 'Gate test',
    GIT_COMMITTER_EMAIL: 'gate@example.invalid',
  }
  const git = (...args) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
      cwd: repo,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  const put = (path, text = path) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), text)
  }
  const commit = () => {
    git('add', '.')
    git('commit', '-m', 'fixture')
    return git('rev-parse', 'HEAD')
  }
  let cases = 0
  const check = (previous, current, expected, label, extra = {}, cwd = repo) => {
    const run = spawnSync(process.execPath, [gate], {
      cwd,
      env: {
        ...env,
        VERCEL_ENV: 'production',
        VERCEL_GIT_COMMIT_REF: 'main',
        VERCEL_GIT_PULL_REQUEST_ID: '',
        VERCEL_GIT_PREVIOUS_SHA: previous,
        VERCEL_GIT_COMMIT_SHA: current,
        ...extra,
      },
      encoding: 'utf8',
    })
    assert.equal(run.status, expected, `${label}: ${run.stdout} ${run.stderr}`)
    assert.match(run.stdout, expected === 1 ? /^BUILD:/ : /^(SKIP|HOLD):/, label)
    cases++
  }
  try {
    git('init', '--initial-branch=main')
    put('apps/farm/site.txt')
    put('README.md')
    let previous = commit()
    put('docs/note.md')
    let current = commit()
    check(previous, current, 0, 'docs only')
    check(current, current, 0, 'identical deployed tree')
    previous = current
    for (const path of [
      '.github/workflows/policy.yml',
      'tests/gate.txt',
      '.codegraph/local.txt',
      'AGENTS.md',
      '.codegraph-version',
      'renovate.json',
      'scripts/test-vercel-ignore.mjs',
    ]) {
      put(path)
    }
    current = commit()
    check(previous, current, 0, 'review, tests, and CI metadata only')
    for (const path of [
      'apps/farm/newline\nname.txt',
      'packages/shared/src/input.txt',
      'packages/farm-protocol/src/input.txt',
      'packages/connector/build.mjs',
      'package.json',
      'pnpm-lock.yaml',
      'bun.lock',
      'pnpm-workspace.yaml',
      'tsconfig.json',
      '.npmrc',
      'LICENSE',
      'THIRD_PARTY.md',
      'vercel.json',
      'scripts/vercel-ignore.mjs',
    ]) {
      previous = current
      put(path)
      current = commit()
      check(previous, current, 1, path)
    }
    previous = current
    git('rm', 'apps/farm/site.txt')
    current = commit()
    check(previous, current, 1, 'site deletion')
    previous = current
    git('mv', 'apps/farm/newline\nname.txt', 'docs/moved.txt')
    current = commit()
    check(previous, current, 1, 'rename out of site')
    previous = current
    git('mv', 'docs/moved.txt', 'apps/farm/moved.txt')
    current = commit()
    check(previous, current, 1, 'rename into site')
    for (const [label, extra] of [
      ['feature branch', { VERCEL_GIT_COMMIT_REF: 'feature/nested/name' }],
      ['missing branch', { VERCEL_GIT_COMMIT_REF: '' }],
      ['preview main', { VERCEL_ENV: 'preview' }],
      ['missing environment', { VERCEL_ENV: '' }],
      ['PR metadata', { VERCEL_GIT_PULL_REQUEST_ID: '42' }],
      ['missing prior', { VERCEL_GIT_PREVIOUS_SHA: '' }],
      ['unknown prior', { VERCEL_GIT_PREVIOUS_SHA: 'f'.repeat(40) }],
      ['zero prior', { VERCEL_GIT_PREVIOUS_SHA: '0'.repeat(40) }],
      ['invalid SHA', { VERCEL_GIT_PREVIOUS_SHA: '--help' }],
      ['missing current', { VERCEL_GIT_COMMIT_SHA: '' }],
      ['wrong checkout', { VERCEL_GIT_COMMIT_SHA: previous }],
    ]) {
      check(previous, current, 0, label, extra)
    }
    const deployed = current
    git('checkout', '-b', 'merged-feature')
    put('apps/farm/merged.txt')
    commit()
    put('docs/last-feature-commit.md')
    const feature = commit()
    git('checkout', 'main')
    put('docs/main.md')
    commit()
    git('merge', '--no-ff', 'merged-feature', '-m', 'merge fixture')
    current = git('rev-parse', 'HEAD')
    check(deployed, current, 1, 'multi-commit merge compares deployed tree')
    git('checkout', '-b', 'squashed-feature')
    put('apps/farm/squashed.txt')
    commit()
    put('docs/squashed.md')
    commit()
    git('checkout', 'main')
    git('merge', '--squash', 'squashed-feature')
    previous = current
    current = commit()
    check(previous, current, 1, 'squash merge')
    git('checkout', '-b', 'divergent', deployed)
    put('docs/divergent.md')
    const divergent = commit()
    git('checkout', 'main')
    check(divergent, current, 0, 'non-ancestor prior holds')
    check(feature, current, 1, 'ancestor in merged history')
    const shallow = join(dir, 'shallow')
    git('clone', '--depth=1', '--branch=main', `file://${repo}`, shallow)
    check(previous, current, 0, 'missing prior in shallow clone holds', {}, shallow)
    check(previous, current, 0, 'missing Git repository holds', {}, dir)
    mkdirSync(join(repo, 'apps/farm'), { recursive: true })
    check(previous, current, 1, 'gate works from app root', {}, join(repo, 'apps/farm'))
    writeFileSync(join(repo, 'scripts/vercel-ignore.mjs'), readFileSync(gate))
    for (const [configPath, command] of [
      ['vercel.json', 'node scripts/vercel-ignore.mjs'],
      ['apps/farm/vercel.json', 'node ../../scripts/vercel-ignore.mjs'],
    ]) {
      const config = JSON.parse(readFileSync(join(root, configPath), 'utf8'))
      assert.deepEqual(config.git.deploymentEnabled, { '**': false, main: true })
      assert.ok(config.ignoreCommand.includes(command))
      const allowed = spawnSync('sh', ['-c', config.ignoreCommand], {
        cwd: join(repo, dirname(configPath)),
        env: {
          ...env,
          VERCEL_ENV: 'production',
          VERCEL_GIT_COMMIT_REF: 'main',
          VERCEL_GIT_PULL_REQUEST_ID: '',
          VERCEL_GIT_PREVIOUS_SHA: previous,
          VERCEL_GIT_COMMIT_SHA: current,
        },
        encoding: 'utf8',
      })
      assert.equal(allowed.status, 1, allowed.stderr)
      assert.match(allowed.stdout, /^BUILD:/)
      const missing = spawnSync('sh', ['-c', config.ignoreCommand], { cwd: dir, encoding: 'utf8' })
      assert.equal(missing.status, 0)
      assert.match(missing.stdout, /^HOLD: missing build gate/)
    }
    for (const path of ['.github/workflows/ci.yml', '.github/workflows/sim.yml']) {
      const workflow = readFileSync(join(root, path), 'utf8')
      assert.match(workflow, /^on: \[workflow_dispatch\]$/m)
      assert.match(workflow, /timeout-minutes:/)
      assert.match(workflow, /cancel-in-progress: true/)
    }
    console.log(`${cases} real Git gate cases passed; both configs and manual workflows checked`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
