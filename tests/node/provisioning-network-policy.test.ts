import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MoonrakerConfigurationTarget,
  SpoolmanConfigurationTarget,
} from '../../packages/farm-protocol/src/configuration-target.ts'
import type { ConfigurationRequestFrame } from '../../packages/farm-protocol/src/configuration-frames.ts'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import { createProvisioningEngine } from '../../packages/connector/src/provisioning/engine.ts'
import { createPrinterNetworkPolicy } from '../../packages/connector/src/provisioning/policy.ts'
import {
  trustProvisioningAuthority,
  type ProvisioningContext,
} from '../../packages/connector/src/provisioning/authority.ts'

const NETWORKS = ['192.168.1.0/24'] as const
const SPOOLMAN_ORIGIN = 'http://192.168.1.60:7912'
const REFUSED_HOSTS = ['127.0.0.1', '169.254.169.254', '8.8.8.8'] as const

const directories: string[] = []
test.after(() => {
  for (const directory of directories)
    rmSync(directory, { recursive: true, force: true })
})

function moonrakerTarget(origin: string) {
  return MoonrakerConfigurationTarget.parse({
    v: 1,
    protocol: 'config-v1',
    backend: 'moonraker',
    model: { family: 'klipper-moonraker', provisional: true },
    origin,
  })
}

function spoolmanTarget(origin: string) {
  return SpoolmanConfigurationTarget.parse({
    v: 1,
    protocol: 'config-v1',
    backend: 'spoolman',
    model: { family: 'spoolman', provisional: true },
    origin,
  })
}

function world(
  options: {
    printerNetworks?: readonly string[]
    spoolmanFetch?: typeof fetch
    bootstrapOrigins?: string[]
  } = {},
) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'provision-policy-')))
  directories.push(dir)
  const farm = randomUUID()
  const agent = randomUUID()
  const signer = new ConnectorIdentity(
    generateKeyPairSync('ed25519').privateKey,
  ).configurationReceiptSigner()
  const runtimeConfigPath = join(dir, 'runtime.json')
  writeFileSync(
    runtimeConfigPath,
    JSON.stringify({
      version: 1,
      collection: {
        version: 1,
        allowedOrigins: options.bootstrapOrigins ?? [],
        printers: [],
      },
      assignments: [],
      telemetry: {
        endpoint: 'https://farm.example/telemetry',
        audience: 'test',
      },
    }),
    { mode: 0o600 },
  )
  const engine = createProvisioningEngine({
    stateDirectory: join(dir, 'state'),
    runtime: { runtimeConfigPath, agent_id: agent, farm_id: farm },
    connector: signer,
    managedBridge: null,
    printerNetworks: options.printerNetworks ?? NETWORKS,
    ...(options.spoolmanFetch ? { spoolmanFetch: options.spoolmanFetch } : {}),
    authority: trustProvisioningAuthority({
      isCurrent: async (context) => context.role === 'owner',
      acceptsInventoryAck: async () => true,
    }),
  })
  const binding = {
    account_id: 'owner-1',
    role: 'owner' as const,
    farm_id: farm,
    agent_id: agent,
    key_id: randomUUID(),
    credential_jti: randomUUID(),
    transport_id: randomUUID(),
    connector_fingerprint: signer.fingerprint,
  }
  const send = (frame: ConfigurationRequestFrame) =>
    engine.handle({
      frame,
      context: {
        ...binding,
        action: frame.type,
        capability_id: randomUUID(),
        admission_nonce: 'A'.repeat(43),
      } satisfies ProvisioningContext,
    })
  return { dir, send, runtimeConfigPath }
}

function prepareFrame(
  target:
    ReturnType<typeof moonrakerTarget> | ReturnType<typeof spoolmanTarget>,
) {
  return {
    v: 1 as const,
    protocol: 'config-v1' as const,
    type: 'prepare' as const,
    request_id: randomUUID(),
    operation_id: randomUUID(),
    expected_revision: 0,
    target,
  }
}

function allowedOrigins(path: string): string[] {
  return JSON.parse(readFileSync(path, 'utf8')).collection.allowedOrigins
}

function localRfc1918(): { ip: string; cidr: string } | null {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      const parts = entry.address.split('.').map(Number)
      if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part)))
        continue
      const [a, b] = parts
      let cidr: string | null = null
      if (a === 10) cidr = '10.0.0.0/8'
      else if (a === 172 && b !== undefined && b >= 16 && b <= 31)
        cidr = '172.16.0.0/12'
      else if (a === 192 && b === 168) cidr = '192.168.0.0/16'
      if (cidr && createPrinterNetworkPolicy([cidr]).allows(entry.address))
        return { ip: entry.address, cidr }
    }
  }
  return null
}

test('refuses .0 and .255 hosts inside an allowed private printer CIDR', () => {
  const policy = createPrinterNetworkPolicy(['192.168.1.0/24'])
  assert.equal(policy.allows('192.168.1.0'), false)
  assert.equal(policy.allows('192.168.1.255'), false)
})

test('refuses loopback, link-local and public origins for moonraker and spoolman', async () => {
  const seen: string[] = []
  const spoolmanFetch = (async (input: URL | string) => {
    seen.push(String(input))
    return new Response('[]', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  const w = world({ spoolmanFetch })

  for (const host of REFUSED_HOSTS) {
    const moonraker = await w.send(
      prepareFrame(moonrakerTarget(`http://${host}:7125`)),
    )
    assert.equal(moonraker.type, 'error')
    if (moonraker.type === 'error')
      assert.equal(moonraker.code, 'invalid-request')

    const spoolman = await w.send(
      prepareFrame(spoolmanTarget(`http://${host}:7912`)),
    )
    assert.equal(spoolman.type, 'error')
    if (spoolman.type === 'error')
      assert.equal(spoolman.code, 'invalid-request')
  }

  assert.deepEqual(seen, [])
  assert.deepEqual(allowedOrigins(w.runtimeConfigPath), [])
})

test('accepts a private LAN Spoolman origin', async () => {
  const seen: string[] = []
  const spoolmanFetch = (async (input: URL | string) => {
    seen.push(String(input))
    return new Response('[]', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  const w = world({
    spoolmanFetch,
    bootstrapOrigins: ['http://192.168.1.10:7125'],
  })
  const prepared = await w.send(prepareFrame(spoolmanTarget(SPOOLMAN_ORIGIN)))
  assert.equal(prepared.type, 'result')
  if (prepared.type !== 'result') return
  assert.equal(prepared.state, 'prepared')
  assert.ok(seen.length > 0)
  assert.deepEqual(allowedOrigins(w.runtimeConfigPath), [
    'http://192.168.1.10:7125',
  ])
})

test('accepts a private LAN Moonraker origin past the network policy gate', async () => {
  const lan = localRfc1918()
  assert.ok(lan, 'test host needs a private RFC1918 address')
  const w = world({ printerNetworks: [lan.cidr] })
  // Closed port on a local private address: policy allows, probe fails fast.
  const response = await w.send(
    prepareFrame(moonrakerTarget(`http://${lan.ip}:1`)),
  )
  assert.equal(response.type, 'error')
  if (response.type === 'error') {
    assert.notEqual(response.code, 'invalid-request')
    assert.equal(response.code, 'moonraker-unavailable')
  }
  assert.deepEqual(allowedOrigins(w.runtimeConfigPath), [])
})
