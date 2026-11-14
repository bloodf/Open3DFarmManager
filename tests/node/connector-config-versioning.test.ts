import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  migrateConfig,
  readVersionedRuntimeConfig,
} from '../../packages/connector/src/config/version.ts'

test('migrates bindings without changing their data', () => {
  for (const binding of [
    { kobralink: { printers: [{ id: 'kobra' }] } },
    { printers: [{ origin: 'http://127.0.0.1:7125' }] },
    { bambu: { printers: [{ serial: 'bambu' }] } },
  ]) {
    const input = { version: 1, collection: binding }
    assert.deepEqual(migrateConfig(input), { ...input, schemaVersion: 2 })
    assert.deepEqual(input, { version: 1, collection: binding })
  }
})

test('backs up original bytes, migrates once, and refuses newer versions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'connector-version-'))
  try {
    const path = join(dir, 'config.json')
    const original = '{"version":1,"collection":{"printers":[]}}\n'
    writeFileSync(path, original, { mode: 0o600 })
    assert.deepEqual(readVersionedRuntimeConfig(path), JSON.parse(original))
    assert.equal(readFileSync(`${path}.bak`, 'utf8'), original)
    assert.deepEqual(readVersionedRuntimeConfig(path), JSON.parse(original))
    const future = '{"schemaVersion":999,"secret":"marker"}'
    writeFileSync(path, future)
    assert.throws(
      () => readVersionedRuntimeConfig(path),
      /newer than supported/,
    )
    assert.equal(readFileSync(path, 'utf8'), future)
    assert.equal(readFileSync(`${path}.bak`, 'utf8'), original)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
