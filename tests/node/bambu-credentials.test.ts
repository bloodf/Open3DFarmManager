import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
  linkSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseBambuBinding } from '../../packages/connector/src/bambu/configuration.ts'
import { readBambuCredentials } from '../../packages/connector/src/bambu/credentials.ts'

test('local binding and private credentials enforce boundaries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bambu-test-'))
  try {
    const file = join(dir, 'credential.json')
    writeFileSync(file, JSON.stringify({ accessCode: 'synthetic-secret' }), {
      mode: 0o600,
    })
    const input = {
      printerKey: 'printer',
      host: '192.168.1.2',
      serial: 'ABC_1',
      credentialFile: file,
      pinSha256: 'a'.repeat(64),
      allowedEndpoints: [{ host: '192.168.1.2' }],
    }
    const binding = parseBambuBinding(input)
    assert.equal(binding.port, 8883)
    assert.deepEqual(readBambuCredentials(binding), {
      username: 'bblp',
      password: 'synthetic-secret',
    })
    for (const change of [
      { host: '8.8.8.8' },
      { host: '192.168.1.3' },
      { serial: '../x' },
      { pinSha256: 'bad' },
      { credentialFile: 'relative' },
    ])
      assert.throws(() => parseBambuBinding({ ...input, ...change }))
    chmodSync(file, 0o644)
    assert.throws(
      () => readBambuCredentials(binding),
      /^Error: Invalid Bambu credentials$/,
    )
    chmodSync(file, 0o600)
    const symlink = join(dir, 'symlink')
    symlinkSync(file, symlink)
    assert.throws(() =>
      readBambuCredentials({ ...binding, credentialFile: symlink }),
    )
    const hardlink = join(dir, 'hardlink')
    linkSync(file, hardlink)
    assert.throws(() => readBambuCredentials(binding))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
