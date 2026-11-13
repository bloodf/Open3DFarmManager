// SPDX-License-Identifier: MIT
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { base64url } from '../../../packages/farm-protocol/src/encoding.ts'
import { connectorFingerprintFromSpki } from '../../../packages/farm-protocol/src/configuration-binding.ts'
import {
  createProvisioningEngine,
  trustProvisioningAuthority,
} from '../../../packages/connector/src/provisioning/index.ts'
const farm = randomUUID()
const agent = randomUUID()
const BRIDGE = 'http://127.0.0.1:17100'
export async function setupProvisioning() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kobra-prov-node-')))
  const runtimeConfigPath = join(dir, 'runtime.json')
  writeFileSync(
    runtimeConfigPath,
    JSON.stringify({
      version: 1,
      collection: {
        version: 1,
        allowedOrigins: ['http://127.0.0.1:7125'],
        printers: [{ printerKey: 'voron', origin: 'http://127.0.0.1:7125' }],
      },
      assignments: [
        {
          assignment_id: randomUUID(),
          farm_id: farm,
          agent_id: agent,
          printer_key: 'voron',
          moonraker_origin: 'http://127.0.0.1:7125',
        },
      ],
      telemetry: {
        endpoint: 'https://farm.example/telemetry',
        audience: 'test',
      },
    }),
    { mode: 0o600 },
  )
  const keys = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const fingerprint = await connectorFingerprintFromSpki(
    base64url(
      new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey)),
    ),
  )
  const options = {
    stateDirectory: join(dir, 'state'),
    runtime: { runtimeConfigPath, agent_id: agent, farm_id: farm },
    connector: { fingerprint, receiptKey: keys.privateKey },
    authority: trustProvisioningAuthority({
      isCurrent: async () => true,
      acceptsInventoryAck: async () => true,
    }),
    managedBridge: {
      origin: BRIDGE,
      ownership: 'connector-owned-fresh' as const,
    },
    printerNetworks: ['172.30.78.0/24'],
  }
  const target = {
    v: 1,
    protocol: 'config-v1',
    backend: 'kobralink-anycubic',
    model: { family: 'anycubic-kobra-x', provisional: true },
    endpoint: { ipv4: '172.30.78.3', port: 18910 },
    bridge: { kind: 'connector-managed' },
  }
  let n = 0
  const handle = (
    engine: ReturnType<typeof createProvisioningEngine>,
    frame: Record<string, unknown>,
  ) =>
    engine.handle({
      frame: {
        v: 1,
        protocol: 'config-v1',
        request_id: randomUUID(),
        expected_revision: 0,
        ...frame,
      },
      context: {
        account_id: 'account_1',
        role: 'admin',
        farm_id: farm,
        agent_id: agent,
        key_id: '44444444-4444-4444-8444-444444444444',
        credential_jti: '55555555-5555-4555-8555-555555555555',
        transport_id: '11111111-1111-4111-8111-111111111111',
        connector_fingerprint: fingerprint,
        capability_id: randomUUID(),
        admission_nonce: base64url(new Uint8Array(32).fill(++n)),
        action: frame.type,
      },
    })
  return { dir, options, target, handle, keys, runtimeConfigPath }
}
