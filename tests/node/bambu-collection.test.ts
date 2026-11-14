import test from 'node:test'
import assert from 'node:assert/strict'
import { parseLocalCollectorConfig } from '../../packages/connector/src/config/local.ts'

const binding = {
  printerKey: 'synthetic-bambu', serial: 'SYNTHETIC', host: '127.0.0.1',
  credentialFile: '/synthetic/credential.json', pinSha256: 'a'.repeat(64),
  allowedEndpoints: [{ host: '127.0.0.1', port: 8883 }],
}
const config = { version: 3, allowedOrigins: [], printers: [], bambu: { printers: [binding] } }
test('Bambu collection requires explicit v3 opt-in and local trust', () => {
  assert.equal(parseLocalCollectorConfig(config).version, 3)
  assert.throws(() => parseLocalCollectorConfig({ ...config, version: 2 }))
  assert.throws(() => parseLocalCollectorConfig({ ...config, bambu: { printers: [{ ...binding, pinSha256: undefined }] } }))
})
test('duplicate Bambu identities cannot enter collection', () => {
  assert.throws(() => parseLocalCollectorConfig({ ...config, bambu: { printers: [binding, { ...binding, printerKey: 'other' }] } }))
})
