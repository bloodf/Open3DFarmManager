import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const source = fileURLToPath(new URL('../', import.meta.url))
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'open3d-selftest-regression-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const path of [
    'scripts/test-local-ci.sh',
    'scripts/local-ci.sh',
    'scripts/klipper-diagnostics.mjs',
    '.github/workflows/ci.yml',
    'package.json',
    '.nvmrc',
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    copyFileSync(join(source, path), join(root, path))
  }
  const git = spawnSync('git', ['init', '--quiet', root], { encoding: 'utf8' })
  assert.equal(git.status, 0, git.stderr)
  return root
}
function run(root, env = {}) {
  return spawnSync('bash', ['scripts/test-local-ci.sh'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

test('selftest removes only empty fixtures and retains concurrently populated dependencies', (t) => {
  const root = fixture(t)
  const empty = run(root)
  assert.equal(empty.status, 0, empty.stdout + empty.stderr)
  assert.equal(existsSync(join(root, 'node_modules')), false)

  // The real-node shim simulates an install after fixture creation, before EXIT.
  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(
    join(bin, 'node'),
    `#!/usr/bin/env bash
if [[ \${1:-} == scripts/klipper-diagnostics.mjs ]]; then
  printf '%s\\n' 'concurrent dependency' > node_modules/keep.txt
fi
exec "$REGRESSION_REAL_NODE" "$@"
`,
    { mode: 0o755 },
  )
  const populated = run(root, {
    PATH: `${bin}:${process.env.PATH}`,
    REGRESSION_REAL_NODE: process.execPath,
  })
  assert.equal(populated.status, 0, populated.stdout + populated.stderr)
  assert.equal(
    readFileSync(join(root, 'node_modules/keep.txt'), 'utf8'),
    'concurrent dependency\n',
  )
  assert.match(
    populated.stderr,
    /Retained node_modules: fixture is no longer an empty directory/,
  )

  const existing = run(root)
  assert.equal(existing.status, 0, existing.stdout + existing.stderr)
  assert.equal(
    readFileSync(join(root, 'node_modules/keep.txt'), 'utf8'),
    'concurrent dependency\n',
  )
})

test('workflow-only pnpm pin drift fails the selftest', (t) => {
  const root = fixture(t)
  const path = join(root, '.github/workflows/ci.yml')
  writeFileSync(
    path,
    readFileSync(path, 'utf8').replace(
      /version: '[0-9]+\.[0-9]+\.[0-9]+'/,
      "version: '99.0.0'",
    ),
  )
  const result = run(root)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Workflow pins disagree/)
})

test('maintained Node pins changing together expose stale runner guards', (t) => {
  const root = fixture(t)
  const path = join(root, '.github/workflows/ci.yml')
  writeFileSync(
    path,
    readFileSync(path, 'utf8').replace(
      /node-version: '[0-9]+\.[0-9]+\.[0-9]+'/,
      "node-version: '99.0.0'",
    ),
  )
  writeFileSync(join(root, '.nvmrc'), '99.0.0\n')
  const result = run(root)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Expected 43, got 2/)
})
