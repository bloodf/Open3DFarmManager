import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AnycubicBinding } from '../../packages/connector/src/config/anycubic'
import { probeAnycubic } from '../../packages/connector/src/provisioning/anycubic'
import { MoonrakerConfigurationTarget } from '../../packages/farm-protocol/src/configuration-target'

describe('setup forms', () => {
  it('accepts explicit CA and certificate pin bindings', () => {
    const binding = {
      printerKey: 'test',
      host: '127.0.0.1',
      modelId: 'model',
      deviceId: 'device',
      username: 'user',
      passwordFile: '/private/password',
    }
    expect(
      AnycubicBinding.parse({ ...binding, caFile: '/private/ca.pem' }).caFile,
    ).toBe('/private/ca.pem')
    expect(
      AnycubicBinding.parse({ ...binding, pinSha256: 'a'.repeat(64) })
        .pinSha256,
    ).toBe('a'.repeat(64))
  })
  it('refuses probing without explicit trust', async () => {
    expect(
      await probeAnycubic({
        host: '127.0.0.1',
        port: 9883,
        modelId: 'model',
        deviceId: 'device',
        credentialFile: '/nonexistent',
        signal: new AbortController().signal,
      }),
    ).toBe(false)
  })
  it('keeps input identifiers unique', () => {
    const source = readFileSync('apps/farm/app/pages/impressoras.vue', 'utf8')
    const ids = [...source.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1])
    expect(new Set(ids).size).toBe(ids.length)
  })
  it('rejects oversized Moonraker secrets', () => {
    const target = {
      v: 1,
      protocol: 'config-v1',
      backend: 'moonraker',
      model: { family: 'klipper-moonraker', provisional: true },
      origin: 'http://192.168.1.2',
      username: 'user',
      password: 'x'.repeat(257),
    }
    expect(MoonrakerConfigurationTarget.safeParse(target).success).toBe(false)
  })
})
