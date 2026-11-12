import { describe, expect, test } from 'vitest'
import { createTelemetryRuntimeLifecycle } from '../../apps/farm/server/services/telemetry-runtime-bootstrap.ts'
import { telemetryHttpRuntime } from '../../apps/farm/server/services/telemetry-http-runtime.ts'

describe('telemetry runtime lifecycle', () => {
  test.each([
    'databaseUrl',
    'origin',
    'issuer',
    'audience',
    'publicKeyRegistryPath',
    'tokenTtlSeconds',
    'proofTtlMs',
    'bodyTimeoutMs',
  ])('missing %s never activates telemetry', async (field) => {
    const config: Record<string, unknown> = {
      enabled: true,
      databaseUrl: 'postgres://fixture:synthetic@127.0.0.1:5544/fixture',
      origin: 'https://farm.example',
      issuer: 'https://farm.example',
      audience: 'open3dfarmmanager:connector',
      publicKeyRegistryPath: '/tmp/synthetic-keys.json',
      tokenTtlSeconds: 300,
      proofTtlMs: 30000,
      bodyTimeoutMs: 5000,
    }
    delete config[field]
    const lifecycle = createTelemetryRuntimeLifecycle()
    try {
      expect(await lifecycle.start(config)).toBe('invalid')
      expect(telemetryHttpRuntime()).toBeUndefined()
    } finally {
      await lifecycle.close()
    }
  })

  test('disabled and invalid startup never activate; closed lifecycle cannot start', async () => {
    const lifecycle = createTelemetryRuntimeLifecycle()
    expect(await lifecycle.start({ enabled: false })).toBe('disabled')
    expect(await lifecycle.start({ enabled: true })).toBe('invalid')
    expect(telemetryHttpRuntime()).toBeUndefined()
    await lifecycle.close()
    expect(
      await lifecycle.start({
        enabled: true,
        databaseUrl: 'postgres://fixture:synthetic@127.0.0.1:5544/fixture',
        origin: 'https://farm.example',
        issuer: 'https://farm.example',
        audience: 'open3dfarmmanager:connector',
        publicKeyRegistryPath: '/tmp/synthetic-keys.json',
        tokenTtlSeconds: 300,
        proofTtlMs: 30000,
        bodyTimeoutMs: 5000,
      }),
    ).toBe('unavailable')
    expect(telemetryHttpRuntime()).toBeUndefined()
  })

  test('unreachable database keeps retrying activation until closed', async () => {
    const lifecycle = createTelemetryRuntimeLifecycle()
    let settled = false
    const started = lifecycle
      .startUntilAvailable(
        {
          enabled: true,
          // Reserved port 1 on loopback: refused immediately, never a real server.
          databaseUrl: 'postgres://fixture:synthetic@127.0.0.1:1/fixture',
          origin: 'https://farm.example',
          issuer: 'https://farm.example',
          audience: 'open3dfarmmanager:connector',
          publicKeyRegistryPath: '/tmp/synthetic-keys.json',
          tokenTtlSeconds: 300,
          proofTtlMs: 30000,
          bodyTimeoutMs: 5000,
        },
        { minMs: 20, maxMs: 40 },
      )
      .finally(() => {
        settled = true
      })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(settled).toBe(false)
    expect(telemetryHttpRuntime()).toBeUndefined()
    await lifecycle.close()
    expect(await started).toBe('unavailable')
    expect(telemetryHttpRuntime()).toBeUndefined()
  })
})
