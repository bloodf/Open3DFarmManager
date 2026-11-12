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

  const enabledConfig = {
    enabled: true,
    databaseUrl: 'postgres://fixture:synthetic@127.0.0.1:1/fixture',
    origin: 'https://farm.example',
    issuer: 'https://farm.example',
    audience: 'open3dfarmmanager:connector',
    publicKeyRegistryPath: '/tmp/synthetic-keys.json',
    tokenTtlSeconds: 300,
    proofTtlMs: 30000,
    bodyTimeoutMs: 5000,
  }
  const refused = () =>
    Object.assign(new Error('connect'), { code: 'ECONNREFUSED' })

  test('transient failures retry until activation succeeds, reported once', async () => {
    let attempts = 0
    const failures: string[] = []
    const lifecycle = createTelemetryRuntimeLifecycle({
      activate: async () => {
        if (++attempts < 3) throw refused()
      },
      onFailure: (reason) => failures.push(reason),
    })
    try {
      expect(
        await lifecycle.startUntilAvailable(enabledConfig, {
          minMs: 5,
          maxMs: 10,
        }),
      ).toBe('enabled')
      expect(attempts).toBe(3)
      expect(failures).toEqual(['database-unreachable'])
    } finally {
      await lifecycle.close()
    }
  })

  test('rejected configuration slows to the maximum delay and reports reason changes', async () => {
    const at: number[] = []
    const failures: string[] = []
    let attempts = 0
    const lifecycle = createTelemetryRuntimeLifecycle({
      activate: async () => {
        at.push(performance.now())
        attempts++
        if (attempts === 1) throw refused()
        if (attempts < 4) throw new Error('Invalid telemetry database role')
      },
      onFailure: (reason) => failures.push(reason),
    })
    try {
      expect(
        await lifecycle.startUntilAvailable(enabledConfig, {
          minMs: 5,
          maxMs: 120,
        }),
      ).toBe('enabled')
      expect(failures).toEqual(['database-unreachable', 'rejected'])
      // After a rejection the next attempt waits the maximum delay, not the minimum.
      expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(100)
    } finally {
      await lifecycle.close()
    }
  })
})
