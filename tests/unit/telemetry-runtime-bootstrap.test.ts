import { describe, expect, test } from 'bun:test'
import { createTelemetryRuntimeLifecycle } from '../../apps/farm/server/services/telemetry-runtime-bootstrap.ts'
import { telemetryHttpRuntime } from '../../apps/farm/server/services/telemetry-http-runtime.ts'

describe('telemetry runtime lifecycle', () => {
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
})
