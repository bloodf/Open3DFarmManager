import assert from 'node:assert/strict'
import test from 'node:test'
import { Binding } from '../../packages/connector/src/anycubic-resin/config.ts'

const unsupportedModels = [
  'Anycubic Photon Mono M7 Max',
  'Anycubic Photon Mono M7 Pro',
  'Anycubic Photon Mono 4 Ultra',
  'Anycubic Photon Mono M5s',
  'Anycubic Photon M3 Max',
]

test('refuses each unverified Photon model before a session starts', () => {
  for (const model of unsupportedModels) {
    const result = Binding.safeParse({
      family: 'anycubic-resin',
      printerKey: 'resin-1',
      origin: 'http://127.0.0.1:18910',
      pinSha256: 'a'.repeat(64),
      simulated: true,
      expect: { serial: 'FIXTURE', model },
    })
    assert.equal(result.success, false, model)
    if (!result.success) {
      assert.ok(
        result.error.issues.some((issue) =>
          issue.message.includes(`No LAN session for ${model}`),
        ),
        model,
      )
    }
  }
})
