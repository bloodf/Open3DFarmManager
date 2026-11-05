import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadTelemetryVerificationKeys } from '../../apps/farm/server/services/telemetry-key-registry.ts'

test('public key registry bounds file type, size and key material', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o3dfm-key-registry-'))
  try {
    const file = join(dir, 'keys.json')
    const pem = generateKeyPairSync('ed25519').publicKey.export({
      type: 'spki',
      format: 'pem',
    })
    await writeFile(file, JSON.stringify({ 'test-key': pem }))
    const keys = await loadTelemetryVerificationKeys(file)
    assert.equal(keys.size, 1)
    assert.equal(keys.get('test-key')?.algorithm.name, 'Ed25519')
    const link = join(dir, 'link')
    await symlink(file, link)
    await assert.rejects(loadTelemetryVerificationKeys(link))
    const pipe = join(dir, 'pipe')
    execFileSync('mkfifo', [pipe])
    await assert.rejects(loadTelemetryVerificationKeys(pipe))
    await writeFile(file, 'x'.repeat(65537))
    await assert.rejects(loadTelemetryVerificationKeys(file))
    await writeFile(file, JSON.stringify({ key: 'not a key' }))
    await assert.rejects(loadTelemetryVerificationKeys(file))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
