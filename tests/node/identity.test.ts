import { spawn } from 'node:child_process'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  lstatSync,
  chmodSync,
  symlinkSync,
  linkSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createHash,
  createPublicKey,
  randomBytes,
  verify,
  generateKeyPairSync,
} from 'node:crypto'
import { inspect } from 'node:util'
import {
  ConnectorIdentity,
  loadOrCreateIdentity,
} from '../../packages/connector/src/identity/store.ts'
function scratch() {
  return mkdtempSync(join(tmpdir(), 'open3d-identity-test-'))
}

test('identity is stable across reloads, signs a domain-separated proof and exposes only public metadata', () => {
  const dir = scratch()
  try {
    const first = loadOrCreateIdentity(dir)
    const stored = readFileSync(join(dir, 'identity.json'))
    const second = loadOrCreateIdentity(dir)
    assert.equal(first.fingerprint, second.fingerprint)
    assert.deepEqual(readFileSync(join(dir, 'identity.json')), stored)
    const publicDer = Buffer.from(first.publicKeySpki, 'base64url')
    assert.equal(
      first.fingerprint,
      'SHA256:' + createHash('sha256').update(publicDer).digest('base64url'),
    )
    const publicKey = createPublicKey({
      key: publicDer,
      format: 'der',
      type: 'spki',
    })
    const challenge = randomBytes(32)
    const signature = Buffer.from(first.signProof(challenge), 'base64url')
    assert.ok(
      verify(
        null,
        Buffer.concat([
          Buffer.from('Open3DFarmManager/connector-proof/v1\0'),
          challenge,
        ]),
        publicKey,
        signature,
      ),
    )
    assert.equal(verify(null, challenge, publicKey, signature), false)
    assert.equal(
      verify(
        null,
        Buffer.concat([
          Buffer.from('Open3DFarmManager/connector-proof/v1\0'),
          randomBytes(32),
        ]),
        publicKey,
        signature,
      ),
      false,
    )
    assert.equal(first.signProof(challenge), second.signProof(challenge))
    const privateEncoding = JSON.parse(stored.toString()).privateKey
    assert.equal(JSON.stringify(first).includes(privateEncoding), false)
    assert.equal(inspect(first).includes(privateEncoding), false)
    assert.equal(lstatSync(join(dir, 'identity.json')).mode & 0o777, 0o600)
    assert.equal(lstatSync(join(dir, 'identity.json')).nlink, 1)
    assert.equal(existsSync(join(dir, 'identity.pending')), false)
    assert.equal(existsSync(join(dir, 'identity.init.lock')), false)
    assert.throws(() => first.signProof(new Uint8Array(31)), /32 bytes/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('corrupt and unsupported identity files fail closed without rotating identity', () => {
  for (const content of [
    '{',
    '{}\n',
    '{"version":2,"privateKey":"x"}\n',
    'x'.repeat(1025),
  ]) {
    const dir = scratch()
    try {
      const path = join(dir, 'identity.json')
      writeFileSync(path, content, { mode: 0o600 })
      assert.throws(() => loadOrCreateIdentity(dir))
      assert.equal(readFileSync(path, 'utf8'), content)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})
test('reject public keys and a different private key algorithm', () => {
  const pair = generateKeyPairSync('ed25519')
  assert.throws(() => new ConnectorIdentity(pair.publicKey), /private key/)
  const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  assert.throws(() => new ConnectorIdentity(other.privateKey), /Ed25519/)
})
test('reject symlinks, hard links and shared permissions without modifying targets', () => {
  const dir = scratch()
  try {
    const sourceDir = join(dir, 'source')
    loadOrCreateIdentity(sourceDir)
    const source = join(sourceDir, 'identity.json')
    const before = readFileSync(source)
    const path = join(dir, 'identity.json')
    symlinkSync(source, path)
    assert.throws(() => loadOrCreateIdentity(dir))
    assert.deepEqual(readFileSync(source), before)
    rmSync(path)
    linkSync(source, path)
    assert.throws(() => loadOrCreateIdentity(dir), /private files/)
    rmSync(path)
    chmodSync(source, 0o644)
    assert.throws(() => loadOrCreateIdentity(sourceDir), /private/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('initialization lock and orphan pending identity require explicit recovery', () => {
  const dir = scratch()
  try {
    const lock = join(dir, 'identity.init.lock')
    writeFileSync(lock, 'initializing\n', { mode: 0o600 })
    assert.throws(() => loadOrCreateIdentity(dir), /EEXIST/)
    assert.equal(existsSync(join(dir, 'identity.json')), false)
    rmSync(lock)
    const pending = join(dir, 'identity.pending')
    writeFileSync(pending, 'preserve this pending identity', { mode: 0o600 })
    assert.throws(() => loadOrCreateIdentity(dir), /explicit recovery/)
    assert.equal(
      readFileSync(pending, 'utf8'),
      'preserve this pending identity',
    )
    assert.equal(existsSync(join(dir, 'identity.json')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('concurrent initializers never overwrite the winning identity', async () => {
  const dir = scratch()
  try {
    const module = new URL(
      '../../packages/connector/src/identity/store.ts',
      import.meta.url,
    ).href
    const source = `import { loadOrCreateIdentity } from ${JSON.stringify(module)}; try { process.stdout.write(loadOrCreateIdentity(process.argv[1]).fingerprint) } catch (error) { if (error.code === 'EEXIST' || error.message === 'Identity storage requires regular private files') process.exitCode = 2; else process.exitCode = 3 }`
    const results = await Promise.all(
      Array.from(
        { length: 4 },
        () =>
          new Promise<{ status: number | null; output: string }>(
            (resolve, reject) => {
              const child = spawn(
                process.execPath,
                ['--input-type=module', '-e', source, dir],
                { timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] },
              )
              let output = ''
              child.stdout.on('data', (chunk) => {
                output += chunk
              })
              child.on('error', reject)
              child.on('close', (status) => resolve({ status, output }))
            },
          ),
      ),
    )
    const winner = loadOrCreateIdentity(dir).fingerprint
    assert.ok(results.some((result) => result.status === 0))
    for (const result of results) {
      assert.ok(result.status === 0 || result.status === 2)
      if (result.status === 0) assert.equal(result.output, winner)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('canonical-looking invalid DER and duplicate properties do not trigger regeneration', () => {
  const dir = scratch()
  try {
    const path = join(dir, 'identity.json')
    const invalid =
      JSON.stringify({ version: 1, privateKey: 'A'.repeat(64) }) + '\n'
    writeFileSync(path, invalid, { mode: 0o600 })
    assert.throws(() => loadOrCreateIdentity(dir))
    assert.equal(readFileSync(path, 'utf8'), invalid)
    rmSync(path)
    loadOrCreateIdentity(dir)
    const stored = readFileSync(path, 'utf8')
    const duplicate = stored.replace('{', '{"version":1,')
    writeFileSync(path, duplicate)
    assert.throws(() => loadOrCreateIdentity(dir), /Noncanonical/)
    assert.equal(readFileSync(path, 'utf8'), duplicate)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
