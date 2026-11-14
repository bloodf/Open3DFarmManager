import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

test('CLI valida arquivos privados sem revelar conteúdo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'connector-check-'))
  try {
    const path = join(dir, 'config.json')
    const run = (...args: string[]) =>
      spawnSync(
        process.execPath,
        ['scripts/check-connector-config.ts', ...args],
        { encoding: 'utf8' },
      )
    assert.equal(run('--help').status, 0)
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        allowedOrigins: ['http://127.0.0.1:7125'],
        printers: [
          { printerKey: 'synthetic', origin: 'http://127.0.0.1:7125' },
        ],
      }),
      { mode: 0o600 },
    )
    const valid = run('local', path)
    assert.equal(valid.status, 0, valid.stderr)
    assert.match(valid.stdout, /impressoras: 1/)
    const farm = randomUUID()
    const agent = randomUUID()
    const origin = 'http://127.0.0.1:7125'
    const collection = {
      version: 1,
      allowedOrigins: [origin],
      printers: [{ printerKey: 'printer-1', origin }],
    }
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        collection,
        assignments: [
          {
            assignment_id: randomUUID(),
            farm_id: farm,
            agent_id: agent,
            printer_key: 'printer-1',
            moonraker_origin: origin,
          },
        ],
        telemetry: {
          endpoint: 'https://telemetry.example/api/connector/telemetry',
          audience: 'connector-audience',
        },
      }),
    )
    assert.equal(run('runtime', path, farm, agent).status, 0)
    assert.equal(run('runtime', path, randomUUID(), agent).status, 1)
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        mode: 'configuration-provisioning',
        farm_id: farm,
        agent_id: agent,
        farmOrigin: 'https://farm.example',
        credentialAudience: 'connector-audience',
        stateDirectory: join(dir, 'state'),
        runtimeConfigPath: join(dir, 'runtime'),
        printerNetworks: ['192.168.1.0/24'],
        managedBridge: null,
        runtimeTemplate: { telemetry: {} },
      }),
    )
    const provisioning = run('provisioning', path)
    assert.equal(provisioning.status, 0, provisioning.stderr)
    assert.match(provisioning.stdout, /impressoras: 0/)
    chmodSync(path, 0o644)
    assert.equal(run('local', path).status, 1)
    chmodSync(path, 0o600)
    writeFileSync(path, '{"secret":"private-marker"}')
    const invalid = run('local', path)
    assert.equal(invalid.status, 1)
    assert.doesNotMatch(invalid.stdout + invalid.stderr, /private-marker/)
    assert.equal(run('local', join(dir, 'missing')).status, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
