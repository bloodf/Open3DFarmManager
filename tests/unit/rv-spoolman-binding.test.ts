// SPDX-License-Identifier: AGPL-3.0-or-later
// Spoolman binding against a disposable PostgreSQL cluster. No device or
// Spoolman is contacted: the Connector connection test uses a fake fetch.
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import postgres, { type Sql } from 'postgres'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { recordInventorySnapshot } from '../../apps/farm/server/storage/postgres-inventory-snapshot.ts'
import { PostgresSpoolLibrary } from '../../apps/farm/server/storage/postgres-spool-library.ts'
import { PostgresSpoolmanSettings } from '../../apps/farm/server/storage/postgres-spoolman-settings.ts'
import {
  listIntegrationSpoolUsage,
  searchIntegrationSpools,
  spoolSearchQuery,
  spoolUsageQuery,
} from '../../apps/farm/server/utils/integration-inventory-ledger.ts'
import { registerPhysicalSpool } from '../../apps/farm/server/utils/integration-spool-physical.ts'
import { readAgentRuntimeConfig } from '../../packages/connector/src/config/runtime.ts'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import { trustProvisioningAuthority } from '../../packages/connector/src/provisioning/authority.ts'
import { createProvisioningEngine } from '../../packages/connector/src/provisioning/engine.ts'
import {
  inventoryAt,
  summarizeSpoolman,
} from '../../packages/connector/src/runtime/spool-inventory.ts'
import { parseSpoolmanSpoolInventory } from '../../packages/connector/src/spoolman/read.ts'
import { CONFIGURATION_PROTOCOL } from '../../packages/farm-protocol/src/configuration-common.ts'
import type { ConfigurationRequestFrame } from '../../packages/farm-protocol/src/configuration-frames.ts'
import { configurationReceiptHash } from '../../packages/farm-protocol/src/configuration-receipt.ts'
import {
  SpoolmanConfigurationTarget,
  configurationTargetHash,
} from '../../packages/farm-protocol/src/configuration-target.ts'
import {
  catalogThrough,
  loadMigrationCatalog,
  runMigrations,
} from '../../scripts/db/migrations.ts'
import { disposablePostgres } from '../helpers/disposable-postgres.ts'
import { vitestPostgresOptions } from '../helpers/vitest-postgres.ts'

const origin = 'http://192.168.1.60:7912'
const fixture = disposablePostgres({
  ...vitestPostgresOptions('rv-spoolman'),
  isolated: true,
  through: '0116_spool_moves',
})
let root: Sql
let writer: Sql
let reader: Sql
let settingsSql: Sql
let librarySql: Sql
const directories: string[] = []

/** Rows written by the previous release, then upgraded by the new migrations. */
const upgraded = {
  farmId: randomUUID(),
  agentId: randomUUID(),
  appId: randomUUID(),
  serviceId: randomUUID(),
}

async function loginAs(role: string, name: string) {
  await root.unsafe(
    `CREATE ROLE ${name} LOGIN PASSWORD 'synthetic-role-password' IN ROLE ${role}`,
  )
  const url = new URL(fixture.connectionString)
  url.username = name
  url.password = 'synthetic-role-password'
  return postgres(url.toString(), {
    max: 3,
    onnotice: () => {},
    connection: { search_path: 'pg_catalog' },
  })
}

async function seedFarm(farmId: string, appId: string) {
  const grantId = randomUUID()
  await root`INSERT INTO farm.farms (id, sandbox) VALUES (${farmId}, true)`
  await root`INSERT INTO farm.memberships (farm_id, account_id, role) VALUES (${farmId}, 'rv-owner', 'owner')`
  await root`INSERT INTO farm.integration_apps (id, farm_id, name, sandbox, created_at, created_by)
    VALUES (${appId}, ${farmId}, 'Synthetic shop', true, 0, 'rv-owner')`
  await root`INSERT INTO farm.integration_app_grants (id, app_id, farm_id, scopes, created_at, created_by)
    VALUES (${grantId}, ${appId}, ${farmId}, ARRAY['inventory:read','inventory:write'], 0, 'rv-owner')`
  await root`INSERT INTO farm.spool_filaments (farm_id, id, name, density, diameter, registered_at)
    VALUES (${farmId}, 1, 'PLA', 1.24, 1.75, 0)`
  return {
    farmId,
    appId,
    grantIds: [grantId],
    scope: 'inventory:write' as const,
  }
}

async function enroll(farmId: string, agentId: string) {
  const fingerprint = 'SHA256:' + agentId.replaceAll('-', '').padEnd(43, 'A')
  await root`INSERT INTO farm.connector_enrollments (farm_id, agent_id, public_key_spki, fingerprint)
    VALUES (${farmId}, ${agentId}, repeat('A', 59), ${fingerprint})`
  await root`UPDATE farm.connector_enrollments SET status = 'approved' WHERE agent_id = ${agentId}`
}

function snapshotOf(farmId: string, serviceId: string, spoolIds = [1, 2, 3]) {
  const observedAt = Date.now()
  const inventory = parseSpoolmanSpoolInventory(
    [
      {
        wire: JSON.stringify(
          spoolIds.map((id) => ({
            id,
            filament: { id: 1, name: 'PLA' },
            archived: false,
          })),
        ),
        offset: 0,
        observedAt,
      },
    ],
    { farmId, serviceId, limit: 100 },
  )
  return inventoryAt(
    summarizeSpoolman({ kind: 'observed', inventory, ageMs: 0 })!,
    0,
    observedAt,
  )
}

/** The authenticated telemetry write, with the production writer role. */
async function publish(farmId: string, agentId: string, serviceId: string) {
  await root.begin(async (tx) => {
    await tx`SET LOCAL ROLE farm_connector_telemetry_writer`
    await recordInventorySnapshot(
      tx,
      { farmId, agentId },
      snapshotOf(farmId, serviceId),
      0,
    )
  })
}

type Access = Awaited<ReturnType<typeof seedFarm>>
function bind(
  access: Access,
  serviceId: string,
  spoolId: number,
  key: string = randomUUID(),
) {
  return registerPhysicalSpool(
    writer,
    access,
    { filamentId: 1, location: 'A', spoolman: { serviceId, spoolId } },
    key,
  )
}

async function registered(result: ReturnType<typeof bind>) {
  const value = await result
  if (value?.outcome !== 'registered')
    throw new Error(`Expected a registration, got ${value?.outcome}`)
  return value.spool
}

async function boundKeys(farmId: string) {
  const search = await searchIntegrationSpools(
    reader,
    [farmId],
    spoolSearchQuery(new URLSearchParams())!,
  )
  return search.data.map((row) => ('spoolKey' in row ? row.spoolKey : null))
}

/** Real config-v1 prepare and commit with the service UUID field left blank. */
async function provisionBlankServiceId(farmId: string, agentId: string) {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), 'rv-spoolman-connector-')),
  )
  directories.push(directory)
  const runtimeConfigPath = join(directory, 'runtime.json')
  writeFileSync(
    runtimeConfigPath,
    JSON.stringify({
      version: 1,
      collection: {
        version: 1,
        allowedOrigins: ['http://127.0.0.1:7125'],
        printers: [{ printerKey: 'sim', origin: 'http://127.0.0.1:7125' }],
      },
      assignments: [
        {
          assignment_id: randomUUID(),
          farm_id: farmId,
          agent_id: agentId,
          printer_key: 'sim',
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
  const signer = new ConnectorIdentity(
    generateKeyPairSync('ed25519').privateKey,
  ).configurationReceiptSigner()
  const scope = { runtimeConfigPath, agent_id: agentId, farm_id: farmId }
  const engine = createProvisioningEngine({
    stateDirectory: join(directory, 'state'),
    runtime: scope,
    connector: signer,
    managedBridge: null,
    printerNetworks: ['192.168.1.0/24'],
    spoolmanFetch: async () =>
      new Response('[]', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    authority: trustProvisioningAuthority({
      isCurrent: async () => true,
      acceptsInventoryAck: async () => true,
    }),
  })
  const context = {
    account_id: 'rv-owner',
    role: 'owner' as const,
    farm_id: farmId,
    agent_id: agentId,
    key_id: randomUUID(),
    credential_jti: randomUUID(),
    transport_id: randomUUID(),
    connector_fingerprint: signer.fingerprint,
    admission_nonce: 'A'.repeat(43),
  }
  const send = (frame: ConfigurationRequestFrame) =>
    engine.handle({
      frame,
      context: { ...context, action: frame.type, capability_id: randomUUID() },
    })
  const target = SpoolmanConfigurationTarget.parse({
    v: 1,
    protocol: CONFIGURATION_PROTOCOL,
    backend: 'spoolman',
    model: { family: 'spoolman', provisional: true },
    origin,
  })
  const common = {
    v: 1 as const,
    protocol: CONFIGURATION_PROTOCOL as typeof CONFIGURATION_PROTOCOL,
    operation_id: randomUUID(),
    expected_revision: 0,
  }
  const prepared = await send({
    ...common,
    type: 'prepare',
    request_id: randomUUID(),
    target,
  })
  if (prepared.type !== 'result') throw new Error('Prepare failed')
  const committed = await send({
    ...common,
    type: 'commit',
    request_id: randomUUID(),
    target_sha256: await configurationTargetHash(target),
    prepared_receipt_sha256: await configurationReceiptHash(prepared.receipt),
  })
  expect(committed).toMatchObject({ type: 'result', state: 'local-committed' })
  const serviceId = readAgentRuntimeConfig(runtimeConfigPath, scope).collection
    .spoolman?.serviceId
  if (!serviceId) throw new Error('Connector did not generate a service ID')
  return serviceId
}

const authority = (farmId: string) => ({
  farmId,
  sessionRecordId: 'rv-session',
  policy: { idleTimeoutMs: 1_000_000 },
})

beforeAll(async () => {
  root = await fixture.start()
  await root`INSERT INTO farm.session_accounts (id) VALUES ('rv-owner')`
  await root`INSERT INTO farm.account_sessions (id, account_id, account_version, created_at, last_seen_at, absolute_expires_at)
    VALUES ('rv-session', 'rv-owner', 0, 100, 100, 10000000)`

  const { farmId, agentId, appId, serviceId } = upgraded
  await seedFarm(farmId, appId)
  await enroll(farmId, agentId)
  await root`INSERT INTO farm.spoolman_connector_settings (farm_id, agent_id, origin, status, configured, checked_at, updated_by)
    VALUES (${farmId}, ${agentId}, ${origin}, 'reachable', true, 0, 'rv-owner')`
  const priorSnapshot = snapshotOf(farmId, serviceId)
  await root`INSERT INTO farm.connector_inventory_snapshots
    (farm_id, agent_id, observed_at, received_at, snapshot)
    VALUES (${farmId}, ${agentId}, ${priorSnapshot.observedAt}, ${Date.now()}, ${root.json(priorSnapshot)})`
  await root`INSERT INTO farm.spools (farm_id, id, filament_id, registered_at) VALUES (${farmId}, 1, 1, 0)`
  // Receipt 2 is orphaned: its spool was deleted before the upgrade.
  for (const spoolId of [1, 2])
    await root`INSERT INTO farm.integration_physical_spool_registrations (app_id, idempotency_key, request_hash, response)
      VALUES (${appId}, ${'old-' + spoolId}, 'synthetic', ${root.json({
        farmId,
        spoolId,
        spoolman: { serviceId, spoolId },
      })})`
  await runMigrations(root, await loadMigrationCatalog(), { kind: 'up' })

  writer = await loginAs(
    'farm_spool_features, farm_spool_library, farm_integration_apps',
    'rv_writer',
  )
  reader = await loginAs('farm_integration_apps', 'rv_reader')
  settingsSql = await loginAs('farm_spoolman_settings', 'rv_settings')
  librarySql = await loginAs(
    'farm_spool_library, farm_spool_features',
    'rv_library',
  )
}, 120_000)

afterAll(async () => {
  await Promise.all(
    [writer, reader, settingsSql, librarySql].map((sql) =>
      sql?.end({ timeout: 3 }),
    ),
  )
  await fixture.stop()
  for (const directory of directories)
    rmSync(directory, { recursive: true, force: true })
}, 60_000)

describe('#871 blank Spoolman service UUID', () => {
  test('binds with the UUID the Connector generated, end to end', async () => {
    const farmId = randomUUID()
    const agentId = randomUUID()
    const access = await seedFarm(farmId, randomUUID())
    await enroll(farmId, agentId)
    const serviceId = await provisionBlankServiceId(farmId, agentId)
    const settings = new PostgresSpoolmanSettings(settingsSql, () => 500)
    const save = (savedOrigin: string) =>
      settings.save({
        ...authority(farmId),
        agentId,
        origin: savedOrigin,
        status: 'reachable',
        configured: true,
      })
    expect(await save(origin)).toMatchObject({
      ok: true,
      setting: { serviceId: null },
    })
    // Unknown until the Connector itself reports it.
    expect(await bind(access, serviceId, 1)).toEqual({
      outcome: 'spool-not-observed',
    })
    await publish(farmId, agentId, serviceId)
    expect(await settings.list(authority(farmId))).toMatchObject({
      settings: [{ serviceId }],
    })
    await registered(bind(access, serviceId, 1))
    expect(await boundKeys(farmId)).toEqual([serviceId + ':1'])
    expect(await bind(access, randomUUID(), 2)).toEqual({
      outcome: 'spool-not-observed',
    })
    // A retest of the same address keeps the identity; a new address drops it.
    expect(await save(origin)).toMatchObject({ setting: { serviceId } })
    expect(await save('http://192.168.1.61:7912')).toMatchObject({
      setting: { serviceId: null },
    })
  })

  test('backfills a setting stored before the upgrade', async () => {
    const [row] = await root`
      SELECT service_id, observed_service_id::text AS observed
      FROM farm.spoolman_connector_settings WHERE farm_id = ${upgraded.farmId}`
    expect(row).toEqual({ service_id: null, observed: upgraded.serviceId })
  })

  test('binds through a Connector that has no settings row', async () => {
    const farmId = randomUUID()
    const agentId = randomUUID()
    const serviceId = randomUUID()
    const access = await seedFarm(farmId, randomUUID())
    await enroll(farmId, agentId)
    await publish(farmId, agentId, serviceId)
    await registered(bind(access, serviceId, 1))
  })

  test('a declared UUID and an unapplied setting still fail closed', async () => {
    const farmId = randomUUID()
    const agentId = randomUUID()
    const serviceId = randomUUID()
    const access = await seedFarm(farmId, randomUUID())
    await enroll(farmId, agentId)
    await root`INSERT INTO farm.spoolman_connector_settings (farm_id, agent_id, origin, service_id, status, configured, checked_at, updated_by)
      VALUES (${farmId}, ${agentId}, ${origin}, ${randomUUID()}, 'reachable', true, 0, 'rv-owner')`
    await publish(farmId, agentId, serviceId)
    const rejected = { outcome: 'spool-not-observed' }
    expect(await bind(access, serviceId, 1)).toEqual(rejected)
    await root`UPDATE farm.spoolman_connector_settings SET service_id = NULL, configured = false WHERE farm_id = ${farmId}`
    expect(await bind(access, serviceId, 1)).toEqual(rejected)
  })
})

describe('#882 binding table', () => {
  test('migrates live bindings and skips orphaned receipts', async () => {
    const rows = await root`
      SELECT spool_id::int AS spool, spoolman_spool_id::int AS external
      FROM farm.integration_physical_spool_bindings WHERE farm_id = ${upgraded.farmId}`
    expect([...rows]).toEqual([{ spool: 1, external: 1 }])
  })

  test('deleting the spool releases the binding and ends its replay', async () => {
    const farmId = randomUUID()
    const agentId = randomUUID()
    const serviceId = randomUUID()
    const access = await seedFarm(farmId, randomUUID())
    await enroll(farmId, agentId)
    await publish(farmId, agentId, serviceId)
    const first = await registered(bind(access, serviceId, 1, 'bound'))
    const plainInput = { filamentId: 1, location: 'A' }
    const plain = () =>
      registerPhysicalSpool(writer, access, plainInput, 'plain')
    const unbound = await registered(plain())
    const library = new PostgresSpoolLibrary(librarySql, () => 500)
    for (const spool of [first, unbound])
      expect(
        await library.withScope(
          { kind: 'session', ...authority(farmId) },
          (repo) => repo.spools.delete(spool.spoolId),
        ),
      ).toMatchObject({ ok: true })

    expect(await bind(access, serviceId, 1, 'bound')).toEqual({
      outcome: 'deleted',
    })
    expect(await plain()).toEqual({ outcome: 'deleted' })
    const again = await registered(bind(access, serviceId, 1))
    expect(again.spoolId).not.toBe(first.spoolId)
    // A reused spool number must not revive the old receipt or its binding.
    await root`INSERT INTO farm.spools (farm_id, id, filament_id, registered_at) VALUES (${farmId}, ${first.spoolId}, 1, 0)`
    expect(await bind(access, serviceId, 1, 'bound')).toEqual({
      outcome: 'deleted',
    })
    expect(await boundKeys(farmId)).toEqual([null, serviceId + ':1'])
    await root`DELETE FROM farm.spools WHERE farm_id = ${farmId} AND id = ${first.spoolId}`
  })

  test('the binding does not depend on idempotency receipts', async () => {
    const farmId = randomUUID()
    const agentId = randomUUID()
    const serviceId = randomUUID()
    const access = await seedFarm(farmId, randomUUID())
    await enroll(farmId, agentId)
    await publish(farmId, agentId, serviceId)
    await registered(bind(access, serviceId, 1))
    // What deleting the integration app cascades to.
    await root`DELETE FROM farm.integration_physical_spool_registrations WHERE app_id = ${access.appId}`
    expect(await boundKeys(farmId)).toEqual([serviceId + ':1'])
    expect(await bind(access, serviceId, 1)).toEqual({
      outcome: 'already-bound',
    })
    await expect(
      root`INSERT INTO farm.spools (farm_id, id, filament_id, registered_at) VALUES (${farmId}, 99, 1, 0)`.then(
        () =>
          root`INSERT INTO farm.integration_physical_spool_bindings VALUES (${farmId}, 99, ${serviceId}, 1)`,
      ),
    ).rejects.toMatchObject({ code: '23505' })
  })
})

describe('#885 ledger reads', () => {
  test('search and usage join indexed typed columns, not receipt JSON', async () => {
    const statements: string[] = []
    const capture = ((parts: TemplateStringsArray) => {
      statements.push(parts.join('?'))
      return Promise.resolve([])
    }) as unknown as Sql
    await searchIntegrationSpools(
      capture,
      [upgraded.farmId],
      spoolSearchQuery(new URLSearchParams())!,
    )
    await listIntegrationSpoolUsage(
      capture,
      [upgraded.farmId],
      spoolUsageQuery(new URLSearchParams('jobId=1'))!,
    )
    expect(statements).toHaveLength(2)
    for (const statement of statements) {
      expect(statement).toContain('farm.integration_physical_spool_bindings')
      expect(statement).not.toMatch(/registrations|response/)
    }
    const indexes = await root<{ definition: string }[]>`
      SELECT indexdef AS definition FROM pg_indexes
      WHERE schemaname = 'farm' AND tablename = 'integration_physical_spool_bindings'`
    expect(indexes.map(({ definition }) => definition)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('(farm_id, spool_id)'),
        expect.stringContaining(
          '(farm_id, spoolman_service_id, spoolman_spool_id)',
        ),
      ]),
    )
  })
})

// Last: it rolls the binding migrations back and forward again.
describe('migration rollback', () => {
  test('refuses to lose a binding, then round-trips', async () => {
    const catalog = await loadMigrationCatalog()
    const through = (id: string) => catalogThrough(catalog, id)
    const down = (id: string) =>
      runMigrations(root, through(id), { kind: 'down', expectedLastId: id })
    const last = catalog.at(-1)!.id
    expect(last).toBe('0123_spool_observation_permissions')
    await down(last)
    await down('0122_integration_refusal_message')
    await down('0121_spoolman_observation_lock_order')
    await down('0120_inventory_observation_freshness')
    await down('0119_printer_observation_freshness')
    await down('0118_spoolman_effective_service_id')
    await expect(down('0117_physical_spool_bindings')).rejects.toThrow(
      'Cannot roll back',
    )
    await root`DELETE FROM farm.integration_physical_spool_bindings b
      WHERE NOT EXISTS (SELECT 1 FROM farm.integration_physical_spool_registrations r
        WHERE r.response->>'farmId' = b.farm_id::text AND r.response->>'spoolId' = b.spool_id::text)`
    await down('0117_physical_spool_bindings')
    expect(await runMigrations(root, catalog, { kind: 'up' })).toEqual([
      '0117_physical_spool_bindings',
      '0118_spoolman_effective_service_id',
      '0119_printer_observation_freshness',
      '0120_inventory_observation_freshness',
      '0121_spoolman_observation_lock_order',
      '0122_integration_refusal_message',
      '0123_spool_observation_permissions',
    ])
  })
})
