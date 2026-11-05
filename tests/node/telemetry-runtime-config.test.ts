import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseTelemetryRuntimeConfig } from '../../apps/farm/server/services/telemetry-runtime-config.ts'

test('telemetry runtime is opt-in and requires bounded explicit trust configuration', () => {
  const good = {
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
  assert.deepEqual(parseTelemetryRuntimeConfig({ enabled: false }), {
    kind: 'disabled',
  })
  assert.deepEqual(parseTelemetryRuntimeConfig({}), { kind: 'disabled' })
  assert.equal(parseTelemetryRuntimeConfig(good).kind, 'enabled')
  for (const change of [
    { databaseUrl: 'postgres://fixture@localhost/fixture' },
    { origin: 'http://farm.example' },
    { publicKeyRegistryPath: 'relative' },
    { proofTtlMs: 60001 },
    { tokenTtlSeconds: 0 },
    { bodyTimeoutMs: 0 },
    { unknown: true },
  ]) {
    assert.equal(
      parseTelemetryRuntimeConfig({ ...good, ...change }).kind,
      'invalid',
    )
  }
})
