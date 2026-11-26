/**
 * #937: emergency_stop moves from control:extended to the consent-gated scope
 * control:emergency. Real PostgreSQL; nothing here reaches a printer.
 */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { build } from 'esbuild'
import type { Sql } from 'postgres'
import { compileScript, parse } from 'vue/compiler-sfc'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  catalogThrough,
  loadMigrationCatalog,
  runMigrations,
} from '../../scripts/db/migrations.ts'
import { IntegrationActionsService } from '../../apps/farm/server/services/integration-actions.ts'
import { IntegrationAppsService } from '../../apps/farm/server/services/integration-apps.ts'
import { IntegrationAuditService } from '../../apps/farm/server/services/integration-audit.ts'
import { IntegrationDeliveryService } from '../../apps/farm/server/services/integration-delivery.ts'
import { PostgresIntegrationActions } from '../../apps/farm/server/storage/integration-actions-postgres.ts'
import { PostgresIntegrationApps } from '../../apps/farm/server/storage/integration-apps-postgres.ts'
import { PostgresIntegrationAudit } from '../../apps/farm/server/storage/integration-audit-postgres.ts'
import { PostgresIntegrationDelivery } from '../../apps/farm/server/storage/integration-delivery-postgres.ts'
import {
  authorizeIntegrationRequest,
  integrationBase,
} from '../../apps/farm/server/utils/integration-auth-http.ts'
import {
  IntegrationAuth,
  parseIntegrationTokenConfig,
} from '../../apps/farm/server/utils/integration-auth.ts'
import { listIntegrationPrinters } from '../../apps/farm/server/utils/integration-printers.ts'
import { decodeApiEnvelopeFrame } from '../../packages/farm-protocol/src/api-envelope.ts'
import { startHttpMock } from '../../packages/sim-tools/src/mocks/http-mock'
import { launchBrowser } from '../helpers/browser'
import {
  disposablePostgres,
  findPostgresBin,
} from '../helpers/disposable-postgres.ts'
import { vitestPostgresOptions } from '../helpers/vitest-postgres.ts'

let postgresReady = false
try {
  if (process.env.OPENFARM_PG !== 'docker') findPostgresBin()
  postgresReady = true
} catch {
  // The unit suite also runs on hosts with no PostgreSQL executable.
}

const BEFORE = '0127_camera_stream_filament_slot'
const AFTER = '0128_integration_emergency_scope'

/** Every definition the migration replaces, as PostgreSQL reports it. */
async function definitions(sql: Sql) {
  const rows = await sql<{ definition: string }[]>`
    SELECT pg_get_functiondef(p.oid) AS definition FROM pg_proc p
    WHERE p.pronamespace = 'farm'::regnamespace
      AND p.proname IN ('integration_action_guard', 'integration_scopes_valid')
    UNION ALL
    SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
    WHERE c.conname IN ('integration_actions_required_scope_check', 'integration_envelopes_required_scope_check')
    ORDER BY 1`
  return rows.map((row) => row.definition)
}

describe.skipIf(!postgresReady)('#937 migration 0128', () => {
  const pg = disposablePostgres({
    ...vitestPostgresOptions('openfarm-fix-937'),
    isolated: true,
    through: BEFORE,
  })
  const farm = randomUUID()
  const agent = randomUUID()
  const printer = randomUUID()
  const owner = 'acct_' + randomUUID().replaceAll('-', '')
  const oldApp = randomUUID()
  const oldGrant = randomUUID()
  let sql: Sql
  let before: string[]
  let catalog: Awaited<ReturnType<typeof loadMigrationCatalog>>
  const sent: string[] = []

  const up = () => runMigrations(sql, catalog, { kind: 'up' })
  const down = () =>
    runMigrations(sql, catalog, { kind: 'down', expectedLastId: AFTER })

  beforeAll(async () => {
    sql = await pg.start()
    catalog = catalogThrough(await loadMigrationCatalog(), AFTER)
    await sql`INSERT INTO farm.session_accounts (id) VALUES (${owner})`
    await sql`INSERT INTO farm.farms (id, sandbox) VALUES (${farm}, false)`
    await sql`INSERT INTO farm.memberships (farm_id, account_id, role) VALUES (${farm}::uuid, ${owner}, 'owner')`
    await sql`INSERT INTO farm.connector_enrollments (agent_id, farm_id, public_key_spki, fingerprint) VALUES (${agent}::uuid, ${farm}::uuid, ${'k'.repeat(59)}, ${'fix937'.padEnd(50, 'f')})`
    await sql`UPDATE farm.connector_enrollments SET status = 'approved' WHERE agent_id = ${agent}::uuid`
    await sql`INSERT INTO farm.printer_assignments (id, farm_id, agent_id, printer_key, created_at, created_by) VALUES (${printer}::uuid, ${farm}::uuid, ${agent}::uuid, 'printer-a', 1, ${owner})`
    await sql`INSERT INTO farm.printer_latest_state (farm_id, agent_id, printer_key, observed_at, state, received_at, age_at_send_ms)
      VALUES (${farm}::uuid, ${agent}::uuid, 'printer-a', ${Date.now()}, ${sql.json({ printerKey: 'printer-a', observedAt: Date.now(), state: 'printing', progress: 0, controls: ['pause', 'emergency_stop'] })}, ${Date.now()}, 0)`
    // The grant an owner made before the new scope existed.
    await sql`INSERT INTO farm.integration_apps (id, farm_id, name, sandbox, created_at, created_by) VALUES (${oldApp}::uuid, ${farm}::uuid, 'old', false, 1, ${owner})`
    await sql`INSERT INTO farm.integration_app_grants (id, app_id, farm_id, printer_assignment_id, scopes, requires_approval, created_at, created_by) VALUES (${oldGrant}::uuid, ${oldApp}::uuid, ${farm}::uuid, ${printer}::uuid, ${['printers:read', 'control:extended']}::text[], false, 1, ${owner})`
    before = await definitions(sql)
  }, 120_000)
  afterAll(() => pg.stop())

  /** A real access token for the app, checked by the real route policy. */
  async function client(appId: string) {
    const store = new PostgresIntegrationApps(sql)
    const issued = await new IntegrationAppsService(store).issueCredential(
      owner,
      appId,
    )
    if (typeof issued !== 'object') throw new Error(issued)
    const auth = new IntegrationAuth(
      store,
      parseIntegrationTokenConfig({
        signingKey: Buffer.alloc(32, 7).toString('base64url'),
        tokenTtlSeconds: '600',
      }),
    )
    const token = await auth.issue(
      issued.credential.clientId,
      issued.secret,
      undefined,
    )
    if (typeof token === 'string') throw new Error(token)
    const authorize = async (path: string, body?: object) =>
      await authorizeIntegrationRequest(
        new Request('https://farm.test' + integrationBase + path, {
          method: body ? 'POST' : 'GET',
          headers: {
            authorization: 'Bearer ' + token.access_token,
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
        path,
        () => auth,
      )
    return {
      authorize,
      principal: (await auth.verify(token.access_token))!,
      async controls() {
        const allowed = await authorize('/printers')
        if (allowed instanceof Response) throw new Error('refused')
        const listed = await listIntegrationPrinters(
          allowed.principal,
          store,
          new URLSearchParams(),
        )
        if (!('data' in listed)) throw new Error(listed.error)
        return listed.data![0]!.controls
      },
    }
  }

  async function actions() {
    const key = await crypto.subtle.generateKey('Ed25519', false, [
      'sign',
      'verify',
    ])
    const deliveryStore = new PostgresIntegrationDelivery(sql)
    const delivery = new IntegrationDeliveryService({
      store: deliveryStore,
      inbox: {
        sendToAgentInbox(_farm, _agent, wire) {
          sent.push(wire)
          return 'sent'
        },
      },
      audit: new IntegrationAuditService(new PostgresIntegrationAudit(sql)),
      signer: { kid: 'api-1', signingKey: key.privateKey },
    })
    return new IntegrationActionsService({
      store: new PostgresIntegrationActions(sql),
      envelopes: {
        issue: (input) => delivery.issue(input),
        deliver: (id) => delivery.deliver(id),
        get: (id) => deliveryStore.get(id),
      },
    })
  }

  const insertAction = (appId: string, grantId: string, scope: string) =>
    sql`INSERT INTO farm.integration_actions (id, app_id, grant_id, farm_id, printer_assignment_id, idempotency_key, request_hash, action, required_scope, status, created_at, updated_at)
      VALUES (${randomUUID()}::uuid, ${appId}::uuid, ${grantId}::uuid, ${farm}::uuid, ${printer}::uuid, ${randomUUID()}, ${'a'.repeat(64)}, ${sql.json({ action: 'emergency_stop', args: {} })}, ${scope}, 'submitted', ${Date.now()}, ${Date.now()})`

  const stop = { action: 'emergency_stop', args: {} }
  const path = `/printers/${printer}/actions`

  it('rolls back to the 0125 definitions while the scope is unused', async () => {
    await up()
    expect(await definitions(sql)).not.toEqual(before)
    await down()
    expect(await definitions(sql)).toEqual(before)
    await up()
  })

  it('takes emergency stop away from an existing control:extended grant', async () => {
    const [grant] = await sql<{ scopes: string[] }[]>`
      SELECT scopes FROM farm.integration_app_grants WHERE id = ${oldGrant}::uuid`
    expect(grant!.scopes).toEqual(['printers:read', 'control:extended'])
    const app = await client(oldApp)
    const refused = await app.authorize(path, stop)
    expect(refused).toBeInstanceOf(Response)
    expect((refused as Response).status).toBe(403)
    expect(
      await (await actions()).submit(app.principal, printer, 'old-stop', stop),
    ).toEqual({ ok: false, problem: 'insufficient-scope' })
    await expect(
      insertAction(oldApp, oldGrant, 'control:extended'),
    ).rejects.toThrow('Action scope mismatch')
    await expect(
      insertAction(oldApp, oldGrant, 'control:emergency'),
    ).rejects.toThrow('The grant lacks the action scope')
    expect(await app.controls()).toEqual(['pause'])
    expect(sent).toEqual([])
  })

  it('accepts emergency stop under a fresh control:emergency grant', async () => {
    const apps = new IntegrationAppsService(new PostgresIntegrationApps(sql))
    const created = await apps.createApp(owner, {
      farmId: farm,
      name: 'new',
      sandbox: false,
    })
    if (typeof created !== 'object') throw new Error(created)
    const grant = await apps.createGrant(owner, {
      appId: created.id,
      farmId: farm,
      scopes: ['printers:read', 'control:emergency'],
    })
    if (typeof grant !== 'object') throw new Error(grant)
    const app = await client(created.id)
    expect(await app.controls()).toEqual(['pause', 'emergency_stop'])
    const allowed = await app.authorize(path, stop)
    if (allowed instanceof Response) throw new Error(String(allowed.status))
    const result = await (
      await actions()
    ).submit(allowed.principal, printer, 'new-stop', stop)
    if (!result.ok) throw new Error(result.problem)
    expect(result.action.status).toBe('queued')
    expect(sent).toHaveLength(1)
    expect(decodeApiEnvelopeFrame(sent[0]!).envelope.scope).toBe(
      'control:emergency',
    )
    const read = await app.authorize(`/actions/${result.action.id}`)
    expect(read).not.toBeInstanceOf(Response)
    // The new scope covers nothing else.
    const other = await app.authorize(path, { action: 'home', args: {} })
    expect((other as Response).status).toBe(403)
  })

  it('refuses to roll back while control:emergency is in use', async () => {
    await expect(down()).rejects.toThrow(
      'Cannot roll back while control:emergency is in use',
    )
    expect(await definitions(sql)).not.toEqual(before)
  })
})

/** Google Chrome where installed; otherwise the helper's bundled Chromium. */
async function pageBrowser() {
  const options = { args: ['--disable-background-networking'] }
  try {
    return await launchBrowser(options)
  } catch (error) {
    if (!String(error).includes("distribution 'chrome' is not found"))
      throw error
    vi.stubEnv('OPENFARM_BROWSER', 'bundled')
    try {
      return await launchBrowser(options)
    } finally {
      vi.unstubAllEnvs()
    }
  }
}

it('#937: the Integrações page lists the scope with its consent text', async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import { createApp, h, ref, watch, onMounted, onBeforeUnmount, computed } from 'vue'
        import Integrations from './apps/farm/app/pages/integracoes.vue'
        Object.assign(globalThis, { ref, watch, onMounted, onBeforeUnmount, computed })
        globalThis.useRoute = () => ({ query: { farm: 'fixture' } })
        globalThis.useRouter = () => ({ replace() {} })
        globalThis.$fetch = async (url) => {
          if (url === '/api/farms') return { farms: [{ farmId: 'fixture' }] }
          if (url.endsWith('/integrations/apps')) return { apps: [{ id: 'app', name: 'Aplicativo', revokedAt: null }], printers: [] }
          return { grants: [] }
        }
        const app = createApp(Integrations)
        app.component('NuxtLink', { props: ['to'], render() { return h('a', this.$slots.default?.()) } })
        app.mount('#app')
      `,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    outfile: 'integrations.js',
    plugins: [
      {
        name: 'vue',
        setup(build) {
          build.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
            const { descriptor, errors } = parse(await readFile(path, 'utf8'), {
              filename: path,
            })
            if (errors.length) throw new Error(errors.join('\n'))
            const code = compileScript(descriptor, {
              id: basename(path),
              inlineTemplate: true,
              genDefaultAs: 'component',
            }).content
            return {
              loader: 'ts',
              resolveDir: dirname(path),
              contents: `${code}\nexport default component`,
            }
          })
        },
      },
    ],
  })
  const server = await startHttpMock({
    port: 0,
    routes: {
      '/integrations.js': (_, res) => {
        res.setHeader('content-type', 'text/javascript')
        res.end(bundle.outputFiles[0]!.text)
      },
      '/': (_, res) => {
        res.setHeader('content-type', 'text/html')
        res.end(
          '<!doctype html><html lang="pt-BR"><meta charset="utf-8"><div id="app"></div><script src="/integrations.js"></script></html>',
        )
      },
    },
  })
  const browser = await pageBrowser()
  try {
    const page = await browser.newPage()
    page.setDefaultTimeout(5000)
    await page.goto(`${server.origin}/`)
    const box = page.getByRole('checkbox', {
      name: 'Parada de emergência (control:emergency)',
    })
    await box.waitFor()
    expect(await box.isChecked()).toBe(false)
    const consent = await box.evaluate(
      (node) =>
        document.getElementById(node.getAttribute('aria-describedby') ?? '')
          ?.textContent,
    )
    const text = consent?.replace(/\s+/g, ' ')
    expect(text).toContain('poderá parar a impressora imediatamente')
    expect(text).toContain('A API não consegue recuperar a impressora')
    expect(text).toContain(
      'agir na própria impressora ou no OpenFarm pelo navegador (reiniciar o firmware)',
    )
  } finally {
    await browser.close()
    await server.close()
  }
})
