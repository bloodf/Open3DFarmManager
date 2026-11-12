import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  readFileSync,
  existsSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  loadOrCreateIdentity,
  loadExistingIdentity,
} from '../../packages/connector/src/identity/store.ts'
import { ConnectorProofChallenges } from '../../apps/farm/server/services/connector-proof.ts'
const cli =
  process.env.OPEN3DFARM_TEST_CLI ??
  fileURLToPath(new URL('../../packages/connector/src/cli.ts', import.meta.url))
function run(...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    // Hang detector only. A ~0.5 s cold start exceeded 5 s while the host ran
    // several gates at once; status assertions below stay exact.
    timeout: 30000,
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
      [
        'collect',
        '--config',
        'absent',
        '--data-dir',
        absent,
        '--status-port',
        '8080',
      ],
      [
        'run',
        '--config',
        'absent',
        '--data-dir',
        absent,
        '--credential-file',
        'absent',
        '--status-port',
        '0',
      ],
      [
        'run',
        '--config',
        'absent',
        '--data-dir',
        absent,
        '--credential-file',
        'absent',
        '--status-port',
        '65536',
      ],
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

test('explicit identity initialization survives CLI restart and proves possession using its public output', () => {
  const root = mkdtempSync(join(tmpdir(), 'open3d-init-cli-'))
  const directory = join(root, 'data')
  try {
    const initialized = run('init-identity', '--data-dir', directory)
    assert.equal(initialized.status, 0, initialized.stderr)
    const publicIdentity = JSON.parse(initialized.stdout)
    assert.deepEqual(Object.keys(publicIdentity).sort(), [
      'algorithm',
      'fingerprint',
      'publicKeySpki',
    ])
    const before = readFileSync(join(directory, 'identity.json'))
    const repeated = run('init-identity', '--data-dir', directory)
    assert.equal(repeated.status, 0, repeated.stderr)
    assert.equal(repeated.stdout, initialized.stdout)
    assert.deepEqual(readFileSync(join(directory, 'identity.json')), before)
    const query = run('identity', '--data-dir', directory)
    assert.equal(query.status, 0, query.stderr)
    assert.equal(query.stdout, initialized.stdout)
    const identity = loadExistingIdentity(directory)
    const id = '00000000-0000-4000-8000-000000000001'
    const binding = {
      farmId: id,
      agentId: id,
      connectionId: id,
      publicKeySpki: publicIdentity.publicKeySpki,
      fingerprint: publicIdentity.fingerprint,
      revoked: false,
    }
    const server = new ConnectorProofChallenges()
    const challenge = server.issue(binding, 1000, 5000)
    assert.equal(
      server.complete(
        challenge.nonce,
        identity.signProof(Buffer.from(challenge.nonce, 'base64url')),
        binding,
        1001,
      ),
      true,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
test('initialization needs an explicit directory and never replaces corrupt identity data', () => {
  const root = mkdtempSync(join(tmpdir(), 'open3d-init-cli-'))
  try {
    const directory = join(root, 'data')
    for (const args of [
      ['init-identity'],
      ['init-identity', '--version', '--data-dir', directory],
      ['init-identity', '--data-dir', directory, 'extra'],
    ]) {
      const result = run(...args)
      assert.equal(result.status, 1)
      assert.equal(result.stdout, '')
    }
    assert.equal(existsSync(directory), false)
    loadOrCreateIdentity(directory)
    const marker = 'SYNTHETIC_PRIVATE_IDENTITY_MARKER'
    writeFileSync(join(directory, 'identity.json'), marker)
    const result = run('init-identity', '--data-dir', directory)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.ok(!result.stderr.includes(marker))
    assert.ok(!result.stderr.includes(directory))
    assert.equal(readFileSync(join(directory, 'identity.json'), 'utf8'), marker)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
