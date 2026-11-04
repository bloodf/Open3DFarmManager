import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  readFileSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadOrCreateIdentity } from '../../packages/connector/src/identity/store.ts'
const cli =
  process.env.OPEN3DFARM_TEST_CLI ??
  fileURLToPath(new URL('../../packages/connector/src/cli.ts', import.meta.url))
function run(...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    timeout: 5000,
  })
}

test('identity CLI emits public JSON and leaves existing files unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'open3d-identity-cli-'))
  try {
    const identity = loadOrCreateIdentity(dir)
    const before = readFileSync(join(dir, 'identity.json'))
    const files = readdirSync(dir)
    const result = run('identity', '--data-dir', dir)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), identity.toJSON())
    assert.deepEqual(readdirSync(dir), files)
    assert.deepEqual(readFileSync(join(dir, 'identity.json')), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('missing identity and invalid arguments never initialize files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'open3d-identity-cli-'))
  try {
    const absent = join(dir, 'absent')
    for (const args of [
      ['identity', '--data-dir', absent],
      ['identity'],
      ['identity', '--data-dir', dir],
      ['pair'],
      ['--version', 'identity'],
      ['--unknown'],
    ]) {
      const result = run(...args)
      assert.equal(result.status, 1)
      assert.equal(result.stdout, '')
      assert.ok(!result.stderr.includes(dir))
      assert.ok(!result.stderr.includes('Error:'))
    }
    assert.equal(existsSync(absent), false)
    assert.deepEqual(readdirSync(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('help and version do not require an identity', () => {
  const help = run('--help')
  assert.equal(help.status, 0)
  assert.ok(help.stdout.includes('não cria uma identidade'))
  const version = run('--version')
  assert.equal(version.status, 0)
  assert.equal(version.stdout.trim(), '0.0.1')
})
