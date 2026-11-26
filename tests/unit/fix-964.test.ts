import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import {
  disposablePostgres,
  findPostgresBin,
} from '../helpers/disposable-postgres.ts'
import { vitestPostgresOptions } from '../helpers/vitest-postgres.ts'
import { PostgresPrinterProfiles } from '../../apps/farm/server/storage/postgres-printer-profiles.ts'

const state = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  account: '',
  profiles: undefined as any,
}))
vi.mock('nuxt/server', () => ({
  useRuntimeConfig: () => ({ integrationAuth: state.config }),
  createError: (input: object) =>
    Object.assign(new Error('request error'), input),
}))
vi.mock('../../apps/farm/server/utils/auth/runtime.ts', () => ({
  authRuntime: () => ({ idleTimeoutMs: 300000 }),
}))
vi.mock('../../apps/farm/server/services/authenticated-session.ts', () => ({
  authResponse: () => {},
  authenticatedSession: async () => ({ accountId: state.account }),
  sealedSessionRecordId: async () => state.account,
}))
vi.mock('../../apps/farm/server/utils/printer-assignments/runtime.ts', () => ({
  printerAssignmentsRuntime: async () => ({ profiles: state.profiles }),
}))
import { farmFleetMode } from '../../apps/farm/server/services/fleet-mode-http.ts'
import { closeIntegrationAuthRuntime } from '../../apps/farm/server/utils/integration-auth-runtime.ts'

let ready = false
try {
  if (process.env.OPENFARM_PG !== 'docker') findPostgresBin()
  ready = true
} catch {}
const db = disposablePostgres({
  ...vitestPostgresOptions('openfarm-fix-964'),
  isolated: true,
})
const farm = randomUUID(),
  otherFarm = randomUUID(),
  printer = randomUUID(),
  otherPrinter = randomUUID()
const owner = 'owner964',
  outsider = 'outsider964'
const event = {
  req: new Request('http://localhost'),
  res: { headers: new Headers() },
} as never
beforeAll(async () => {
  if (!ready) return
  const sql = await db.start()
  state.profiles = new PostgresPrinterProfiles(sql)
  const now = Date.now()
  for (const account of [owner, outsider]) {
    await sql`INSERT INTO farm.session_accounts (id) VALUES (${account})`
    await sql`INSERT INTO farm.account_sessions (id, account_id, account_version, created_at, last_seen_at, absolute_expires_at) VALUES (${account}, ${account}, 0, ${now}, ${now}, ${now + 3600000})`
  }
  for (const [id, assignment] of [
    [farm, printer],
    [otherFarm, otherPrinter],
  ] as const) {
    const agent = randomUUID()
    await sql`INSERT INTO farm.farms (id, sandbox) VALUES (${id}, false)`
    await sql`INSERT INTO farm.memberships (farm_id, account_id, role) VALUES (${id}, ${owner}, 'owner')`
    await sql`INSERT INTO farm.connector_enrollments (agent_id, farm_id, public_key_spki, fingerprint) VALUES (${agent}, ${id}, ${'k'.repeat(59)}, ${agent.padEnd(50, 'f')})`
    await sql`UPDATE farm.connector_enrollments SET status = 'approved' WHERE agent_id = ${agent}`
    await sql`INSERT INTO farm.printer_assignments (id, farm_id, agent_id, printer_key, created_at, created_by) VALUES (${assignment}, ${id}, ${agent}, 'test', 1, ${owner})`
  }
  const app = randomUUID()
  await sql`INSERT INTO farm.integration_apps (id, farm_id, name, sandbox, created_at, created_by) VALUES (${app}, ${farm}, 'test', false, 1, ${owner})`
  await sql`INSERT INTO farm.integration_fleet_mode (printer_id, mode, version, app_id) VALUES (${printer}, 'maintenance', ${randomUUID()}, ${app})`
}, 120000)
afterAll(async () => {
  await closeIntegrationAuthRuntime()
  if (ready) await db.stop()
})
it.skipIf(!ready)(
  'falls back only when integrations are unconfigured and preserves authorization',
  async () => {
    state.account = owner
    state.config = { enabled: false }
    expect(await farmFleetMode(event, farm, printer)).toEqual({
      mode: 'in-service',
    })
    state.account = outsider
    await expect(farmFleetMode(event, farm, printer)).rejects.toMatchObject({
      status: 404,
    })
    state.account = owner
    await expect(
      farmFleetMode(event, farm, otherPrinter),
    ).rejects.toMatchObject({ status: 404 })
    state.config = {
      enabled: true,
      signingKey: Buffer.alloc(32, 1).toString('base64url'),
      tokenTtlSeconds: 60,
      databaseUrl: db.connectionString,
    }
    expect(await farmFleetMode(event, farm, printer)).toEqual({
      mode: 'maintenance',
    })
    await closeIntegrationAuthRuntime()
    state.config = {
      enabled: true,
      signingKey: 'invalid',
      tokenTtlSeconds: 60,
      databaseUrl: db.connectionString,
    }
    await expect(farmFleetMode(event, farm, printer)).rejects.toThrow(
      'Configuração de autenticação de integrações inválida.',
    )
  },
)
