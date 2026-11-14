// Two-printer / four-tool / Spoolman simulator acceptance (issue #2) against
// the real Klipper/Moonraker and Spoolman simulators, the built farm server,
// real enrollment and the real Connector CLI. Read-only: no printer command is
// sent. The caller owns the PostgreSQL container, work directory and ports.
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Effect } from 'effect'
import type { Sql } from 'postgres'
import { loadOrCreateIdentity } from '../../packages/connector/src/identity/store.ts'
import { discoverMoonraker } from '../../packages/connector/src/moonraker/discovery.ts'
import { createSpoolmanProvider } from '../../packages/connector/src/runtime/spoolman-provider.ts'
import { probePrinter } from '../../packages/sim-tools/src/probe.ts'
import { seedSpoolman } from '../../packages/sim-tools/src/spoolman.ts'
import { verifyCamera } from '../../packages/sim-tools/src/verify.ts'
import { ENROLLMENT, enrollConnector } from './connector-enrollment.ts'
import {
  startConnector,
  startFarmApp,
  startFaultProxy,
  until,
} from './connector-outage-fixtures.ts'

const exec = promisify(execFile)
const repo = (path: string) =>
  fileURLToPath(new URL('../../' + path, import.meta.url))

export type SimPorts = {
  db: number
  app: number
  proxy: number
  sv06: number
  u1: number
  spoolman: number
  camera: number
  sv06Cam: number
  u1Cam: number
}
export const simPorts = (base: number): SimPorts => ({
  db: base,
  app: base + 1,
  proxy: base + 2,
  sv06: base + 3,
  u1: base + 4,
  spoolman: base + 5,
  camera: base + 6,
  sv06Cam: base + 7,
  u1Cam: base + 8,
})
const PRINTERS = ['sv06', 'u1'] as const
const LIMITS = {
  maxMessageBytes: 256 * 1024,
  connectTimeoutMs: 3000,
  requestTimeoutMs: 3000,
  staleAfterMs: 300000,
  reconnectMinMs: 500,
  reconnectMaxMs: 5000,
}

/** Simulators from infra/sim with published ports remapped by an override. */
export function simulatorStack(input: {
  project: string
  ports: SimPorts
  workDir: string
  ledger: (value: object) => void
}) {
  const { ports } = input
  const override = join(input.workDir, 'ports.override.yml')
  const publish = (pairs: [number, number][]) =>
    `ports: !override [${pairs.map(([h, c]) => `'127.0.0.1:${h}:${c}'`).join(', ')}]`
  writeFileSync(
    override,
    [
      'services:',
      `  sv06: { ${publish([
        [ports.sv06, 7125],
        [ports.sv06Cam, 8080],
      ])} }`,
      `  u1: { ${publish([
        [ports.u1, 7125],
        [ports.u1Cam, 8080],
      ])} }`,
      `  spoolman: { ${publish([[ports.spoolman, 8000]])} }`,
      `  camera: { ${publish([[ports.camera, 8112]])} }`,
      '',
    ].join('\n'),
  )
  const compose = (...args: string[]) =>
    exec(
      'docker',
      [
        ...['compose', '-p', input.project],
        ...['-f', repo('infra/sim/docker-compose.yml'), '-f', override],
        ...[
          '--profile',
          'klipper',
          '--profile',
          'spoolman',
          '--profile',
          'cams',
        ],
        ...args,
      ],
      { timeout: 900000, maxBuffer: 4 * 1024 * 1024 },
    )
  return {
    origin: (port: number) => `http://127.0.0.1:${port}`,
    async up() {
      input.ledger({ resource: 'compose-project', project: input.project })
      await compose('up', '-d', '--build')
    },
    async down() {
      await compose('down', '--volumes', '--remove-orphans', '--rmi', 'local')
      input.ledger({ removed: 'compose-project', project: input.project })
    },
    logs: async () =>
      (await compose('logs', '--no-color', '--tail', '200')).stdout,
  }
}

export async function runSimFarmAcceptance(input: {
  admin: Sql
  ports: SimPorts
  workDir: string
  ledger: (value: object) => void
}) {
  const { admin, ports, workDir, ledger } = input
  const origin = (port: number) => `http://127.0.0.1:${port}`
  const timings: Record<string, number> = {}
  const t0 = performance.now()
  const mark = (name: string) =>
    (timings[name] = Math.round(performance.now() - t0))

  // 1. Both printers connected and ready within the unchanged 90 s budget.
  for (const printer of PRINTERS)
    await until(
      () =>
        Effect.runPromise(probePrinter(origin(ports[printer]))).then(
          () => true,
          () => false,
        ),
      90000,
      `${printer} ready`,
    )
  mark('printersReady')

  // 2. Spoolman seed is repeatable (2 vendors, 4 filaments, 6 spools).
  const spoolmanOrigin = origin(ports.spoolman)
  const seeded = await seedSpoolman(spoolmanOrigin)
  assert.deepEqual(await seedSpoolman(spoolmanOrigin), seeded)

  // 3. Connector discovery (PR #106) against the genuine Moonraker instances.
  const discovered: Record<string, object> = {}
  for (const printer of PRINTERS) {
    const result = await discoverMoonraker({
      origin: origin(ports[printer]),
      limits: LIMITS,
      signal: AbortSignal.timeout(20000),
      client: {
        name: 'o3dfm-sim-acceptance',
        version: '0.0.1',
        url: 'https://example.invalid',
      },
    })
    assert.equal(result.server.ready, true, `${printer} discovered ready`)
    assert.deepEqual(
      result.webcams.map((webcam) => webcam.name),
      [`${printer}-test-pattern`],
      `${printer} webcam discovered`,
    )
    discovered[printer] = {
      tools: result.tools.tools.map((tool) => tool.object),
      activeTool: result.tools.activeObject,
      webcams: result.webcams.map((webcam) => webcam.name),
    }
  }
  assert.deepEqual(
    (discovered.u1 as { tools: string[] }).tools,
    ['extruder', 'extruder1', 'extruder2', 'extruder3'],
    'u1 exposes four tools',
  )
  assert.deepEqual((discovered.sv06 as { tools: string[] }).tools, ['extruder'])
  // One JPEG frame from each printer webcam and from the camera service.
  const snapshotBytes = {
    sv06: await verifyCamera(origin(ports.sv06Cam)),
    u1: await verifyCamera(origin(ports.u1Cam)),
    camera: await verifyCamera(origin(ports.camera)),
  }
  mark('discovered')

  // 4. Connector Spoolman provider observes the seeded inventory.
  const farmIdForProvider = randomUUID()
  const providerAbort = new AbortController()
  let observed: number | null = null
  const provider = createSpoolmanProvider({
    config: {
      origin: spoolmanOrigin,
      farmId: farmIdForProvider,
      serviceId: randomUUID(),
      limit: 200,
    },
    signal: providerAbort.signal,
    onSnapshot(snapshot) {
      if (snapshot.kind === 'observed' && snapshot.inventory)
        observed = snapshot.inventory.items.length
    },
  })
  try {
    await until(() => observed !== null, 30000, 'spoolman inventory observed')
  } finally {
    providerAbort.abort()
    await provider.done.catch(() => undefined)
  }
  assert.ok(observed === seeded.spools, 'inventory holds the seeded spools')
  mark('inventoryObserved')

  // 5. Real enrollment, built server and Connector CLI for both printers.
  const prefix = 'simaccept_' + randomUUID().replaceAll('-', '')
  const roles = [
    { name: prefix, group: 'farm_connector_telemetry_writer' },
    { name: prefix + '_pair', group: 'farm_pairing_runtime' },
    { name: prefix + '_owner', group: 'farm_printer_ownership' },
  ]
  const created: string[] = []
  const pools: Sql[] = []
  const closers: Array<() => Promise<void>> = []
  try {
    for (const role of roles) {
      await admin`CREATE ROLE ${admin(role.name)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE ${admin(role.group)}`
      created.push(role.name)
      ledger({ resource: 'database-role', name: role.name })
    }
    const postgresModule = (await import('postgres')).default
    const connect = (username: string) => {
      const sql = postgresModule({
        host: '127.0.0.1',
        port: ports.db,
        database: 'fixture',
        username,
        password: '',
        ssl: false,
        max: 2,
        connect_timeout: 3,
      })
      pools.push(sql)
      return sql
    }
    const cert = join(workDir, 'tls-cert.pem'),
      tlsKey = join(workDir, 'tls-key.pem')
    execFileSync(
      'openssl',
      [
        ...['req', '-x509', '-newkey', 'ec', '-pkeyopt'],
        ...['ec_paramgen_curve:P-256', '-nodes', '-keyout', tlsKey],
        ...['-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1'],
        ...['-addext', 'subjectAltName=IP:127.0.0.1'],
      ],
      { stdio: 'ignore', timeout: 10000 },
    )
    const dataDir = join(workDir, 'connector-data')
    const identity = loadOrCreateIdentity(dataDir)
    // Pass-through TLS front only; no fault is injected in this acceptance.
    const proxy = await startFaultProxy({
      port: ports.proxy,
      appPort: ports.app,
      cert: readFileSync(cert),
      key: readFileSync(tlsKey),
    })
    closers.push(() => proxy.close())
    ledger({ resource: 'loopback-proxy', port: ports.proxy })
    const enrolled = await enrollConnector({
      admin,
      pairSql: connect(prefix + '_pair'),
      ownerSql: connect(prefix + '_owner'),
      identity,
      origin: proxy.origin,
      workDir,
      printerKeys: PRINTERS,
    })
    const printerOrigins = PRINTERS.map((printer) => origin(ports[printer]))
    const configPath = join(workDir, 'runtime.json'),
      credentialPath = join(workDir, 'credential.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        collection: {
          version: 1,
          allowedOrigins: printerOrigins,
          printers: PRINTERS.map((printerKey, index) => ({
            printerKey,
            origin: printerOrigins[index],
          })),
          limits: { staleAfterMs: 300000, connectTimeoutMs: 3000 },
          spoolman: {
            origin: spoolmanOrigin,
            farmId: enrolled.farmId,
            serviceId: randomUUID(),
          },
        },
        assignments: enrolled.assignments.map((assignment, index) => ({
          assignment_id: assignment.assignmentId,
          farm_id: enrolled.farmId,
          agent_id: enrolled.agentId,
          printer_key: assignment.printerKey,
          moonraker_origin: printerOrigins[index],
        })),
        telemetry: {
          endpoint: proxy.origin + '/api/connector/telemetry',
          audience: ENROLLMENT.audience,
          idleMs: 200,
          timeoutMs: 3000,
          retryMinMs: 500,
          retryMaxMs: 2000,
        },
      }),
      { mode: 0o600, flag: 'wx' },
    )
    writeFileSync(
      credentialPath,
      JSON.stringify({
        version: 1,
        expected_fingerprint: identity.fingerprint,
        approval: enrolled.approval,
      }),
      { mode: 0o600, flag: 'wx' },
    )
    const databaseUrl = (user: string) =>
      `postgres://${encodeURIComponent(user)}:synthetic@127.0.0.1:${ports.db}/fixture`
    const app = startFarmApp({
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        NODE_ENV: 'production',
        NITRO_HOST: '127.0.0.1',
        NITRO_PORT: String(ports.app),
        NUXT_DATABASE_ENABLED: 'true',
        NUXT_DATABASE_DATABASE_URL: databaseUrl('fixture'),
        NUXT_DATABASE_MIGRATIONS: 'verify',
        NUXT_DATABASE_MIGRATIONS_DIR: repo('infra/db/migrations/'),
        NUXT_CONNECTOR_TELEMETRY_ENABLED: 'true',
        NUXT_CONNECTOR_TELEMETRY_DATABASE_URL: databaseUrl(prefix),
        NUXT_CONNECTOR_TELEMETRY_ORIGIN: proxy.origin,
        NUXT_CONNECTOR_TELEMETRY_ISSUER: ENROLLMENT.issuer,
        NUXT_CONNECTOR_TELEMETRY_AUDIENCE: ENROLLMENT.audience,
        NUXT_CONNECTOR_TELEMETRY_PUBLIC_KEY_REGISTRY_PATH: enrolled.keyFile,
        NUXT_CONNECTOR_TELEMETRY_TOKEN_TTL_SECONDS: String(
          ENROLLMENT.ttlSeconds,
        ),
        NUXT_CONNECTOR_TELEMETRY_PROOF_TTL_MS: '30000',
        NUXT_CONNECTOR_TELEMETRY_BODY_TIMEOUT_MS: '5000',
      },
      logPath: join(workDir, 'app.log'),
      onPid: (pid) => ledger({ resource: 'app-process', pid }),
    })
    closers.push(() => app.stop())
    await until(
      async () => {
        if (!app.running) throw new Error('Farm app exited at startup')
        return fetch(`http://127.0.0.1:${ports.app}/readyz`, {
          signal: AbortSignal.timeout(1000),
        }).then(
          (response) => response.status === 200,
          () => false,
        )
      },
      30000,
      'farm app ready',
    )
    mark('appReady')
    const connector = startConnector({
      args: [
        ...['--config', configPath, '--credential-file', credentialPath],
        ...['--data-dir', dataDir],
      ],
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        NODE_EXTRA_CA_CERTS: cert,
      },
      logPath: join(workDir, 'connector.log'),
      onPid: (pid) => ledger({ resource: 'connector-process', pid }),
    })
    closers.push(() => connector.stop())
    // 6. Telemetry from both genuine printers is ingested into PostgreSQL.
    const perPrinter = async () =>
      (await admin`SELECT COALESCE(payload#>>'{state,printerKey}', payload#>>'{transition,printerKey}') AS printer, count(*)::int AS n FROM farm.telemetry_events WHERE agent_id=${enrolled.agentId}::uuid AND farm_id=${enrolled.farmId}::uuid GROUP BY 1`) as unknown as {
        printer: string
        n: number
      }[]
    await until(
      async () => {
        if (!connector.running) throw new Error('Connector exited')
        const rows = await perPrinter()
        return PRINTERS.every((printer) =>
          rows.some((row) => row.printer === printer && row.n >= 1),
        )
      },
      60000,
      'telemetry rows for both printers',
    )
    mark('telemetryIngested')
    // Exactly-once: let the drain settle, stop the Connector, then compare what
    // the collector queued, what the agent delivered and what was stored.
    const delivered = () =>
      connector.diagnostics
        .filter((d) => d.kind === 'delivery' && d.status === 'delivered')
        .reduce((sum, d) => sum + Number(d.count), 0)
    const stored = async () =>
      (
        await admin`SELECT count(*)::int AS n FROM farm.telemetry_events WHERE agent_id=${enrolled.agentId}::uuid`
      )[0]!.n as number
    await until(
      async () =>
        delivered() >= connector.count('queued') &&
        (await stored()) === delivered(),
      30000,
      'telemetry drain settled',
    )
    await connector.stop()
    const stopped = await connector.exited
    assert.deepEqual(stopped, { code: 0, signal: null }, 'Connector clean exit')
    const summary = connector.diagnostics.find((d) => d.kind === 'summary')
    const agentSummary = connector.diagnostics.find(
      (d) => d.kind === 'agent-summary',
    )
    assert.ok(summary && agentSummary, 'Connector summaries present')
    assert.equal(summary.expired, 0)
    assert.equal(summary.capacity, 0)
    const [totals] =
      (await admin`SELECT count(*)::int AS n, count(DISTINCT event_id)::int AS d FROM farm.telemetry_events WHERE agent_id=${enrolled.agentId}::uuid AND farm_id=${enrolled.farmId}::uuid`) as unknown as {
        n: number
        d: number
      }[]
    assert.equal(totals!.n, totals!.d, 'each event stored exactly once')
    assert.equal(totals!.n, summary.queued, 'every queued record stored')
    assert.equal(agentSummary.delivered, summary.queued, 'every record acked')
    const rows = await perPrinter()
    // Idle simulators: exactly one baseline state record per printer.
    assert.deepEqual(
      Object.fromEntries(rows.map((row) => [row.printer, row.n])),
      { sv06: 1, u1: 1 },
    )
    const states =
      (await admin`SELECT DISTINCT payload#>>'{state,state}' AS state FROM farm.telemetry_events WHERE agent_id=${enrolled.agentId}::uuid AND payload ? 'state'`) as unknown as {
        state: string
      }[]
    // Reasons only (fixed labels); a count alone would hide what was unavailable.
    const unavailable = connector.diagnostics
      .filter((diagnostic) => diagnostic.kind === 'unavailable')
      .map((diagnostic) => String(diagnostic.reason))
    mark('connectorStopped')
    return {
      timings,
      seeded,
      discovered,
      snapshotBytes,
      exactlyOnce: {
        queued: summary.queued,
        delivered: agentSummary.delivered,
        stored: totals!.n,
        distinct: totals!.d,
      },
      inventorySpools: observed,
      telemetryRows: Object.fromEntries(
        rows.map((row) => [row.printer, row.n]),
      ),
      printerStates: states.map((row) => row.state).sort(),
      connectorUnavailable: unavailable,
      connectorExit: stopped,
    }
  } finally {
    for (const close of closers.reverse()) await close().catch(() => undefined)
    for (const sql of pools)
      await sql.end({ timeout: 3 }).catch(() => undefined)
    for (const role of created.reverse()) {
      await admin`DROP ROLE ${admin(role)}`
      ledger({ removed: 'database-role', name: role })
    }
  }
}
