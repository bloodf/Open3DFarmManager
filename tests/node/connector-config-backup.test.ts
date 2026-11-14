import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, statSync, readdirSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyConnectorConfig } from '../../scripts/connector-config-backup.ts'

test('private byte copy, restore, no overwrite and failure cleanup', () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'connector-backup-test-'))
  try {
    const source = join(dir, 'source'), backup = join(dir, 'backup'), restored = join(dir, 'restored')
    const bytes = Buffer.from(' {"version":1,"allowedOrigins":["http://127.0.0.1:7125"],"printers":[{"printerKey":"test","origin":"http://127.0.0.1:7125"}]}\n')
    writeFileSync(source, bytes, { mode: 0o600 })
    copyConnectorConfig(source, backup, 'collector')
    copyConnectorConfig(backup, restored, 'collector')
    assert.deepEqual(readFileSync(restored), bytes)
    assert.equal(statSync(restored).mode & 0o777, 0o600)
    assert.throws(() => copyConnectorConfig(source, restored, 'collector'))
    assert.deepEqual(readFileSync(restored), bytes)
    symlinkSync(source, join(dir, 'link'))
    assert.throws(() => copyConnectorConfig(join(dir, 'link'), join(dir, 'out'), 'collector'))
    symlinkSync(dir, join(dir, 'linked-directory'))
    assert.throws(() => copyConnectorConfig(join(dir, 'linked-directory', 'source'), join(dir, 'out'), 'collector'))
    for (const value of ['{}', 'x'.repeat(65537)]) {
      writeFileSync(source, value)
      assert.throws(() => copyConnectorConfig(source, join(dir, 'out'), 'collector'))
    }
    assert.throws(() => copyConnectorConfig(join(dir, '..', 'source'), join(dir, 'out'), 'collector'))
    assert.deepEqual(readdirSync(dir).sort(), ['backup', 'link', 'linked-directory', 'restored', 'source'])
  } finally { rmSync(dir, { recursive: true }) }
})
