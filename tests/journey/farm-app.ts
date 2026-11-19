import {
  execFileSync,
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { signallingHttpsProxy } from '../helpers/signalling-https-proxy.ts'
import { CAPABILITIES, type JourneyDatabase } from './database.ts'
import { resolveNuxtInstall } from './nuxt-install.ts'

const checkout = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
export const AUDIENCE = 'open3dfarmmanager:signalling'
export const PAUSE_KID = 'pause-fixture'
export const PAUSE_AUDIENCE = 'open3dfarmmanager:pause'

export type FarmApp = Readonly<{
  /** `https://127.0.0.1:<port>`: the TLS proxy in front of Nitro. */
  origin: string
  /** PEM certificate the Connector must trust (NODE_EXTRA_CA_CERTS). */
  certificatePath: string
  /** Base64url SPKI of the pause (signed control) issuer the app signs with. */
  pauseIssuerPublicKeySpki: string
  /** Bounded tail of the Nitro output, for failure diagnostics. */
  log(): string
  /** Drops every live upgraded connection, as a network loss would. */
  disconnectUpgrades(): Promise<void>
  /**
   * Opens or closes the Connector's telemetry upload path at the proxy (503
   * while closed, as an upstream outage). Closed at start.
   */
  setTelemetryUpload(open: boolean): void
  directory: string
  close(): Promise<void>
}>

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function freePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('No free loopback port')
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  return address.port
}

/** Runs one owned child to completion; returns the tail of its output. */
async function run(
  command: string,
  args: string[],
  options: SpawnOptions,
  timeoutMs: number,
) {
  const child = spawn(command, args, {
    ...options,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let tail = ''
  const collect = (chunk: Buffer) => {
    tail = (tail + chunk.toString('utf8')).slice(-8192)
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
  try {
    const [code] = (await once(child, 'close')) as [number | null]
    if (code !== 0)
      throw new Error(
        `${[command, ...args].join(' ')} failed (${code})\n${tail}`,
      )
  } finally {
    clearTimeout(timer)
  }
}

/** Stops a child and waits; escalates after a grace period. */
async function stopChild(child: ChildProcess | undefined) {
  if (!child?.pid) return
  const alive = () => child.exitCode === null && child.signalCode === null
  if (alive()) child.kill('SIGTERM')
  if (alive()) await Promise.race([once(child, 'exit'), pause(5000)])
  if (alive()) child.kill('SIGKILL')
  if (alive()) await Promise.race([once(child, 'exit'), pause(5000)])
  if (alive()) throw new Error('Farm app did not exit')
}

/**
 * Builds a signalling-enabled copy of the farm app in a private directory (the
 * default build keeps native WebSockets off), then serves it over loopback
 * HTTPS with every optional runtime wired to the journey database.
 */
export async function startFarmApp(
  database: JourneyDatabase,
  options: { history?: boolean } = {},
): Promise<FarmApp> {
  const directory = await mkdtemp(join(tmpdir(), 'o3dfm-journey-'))
  await chmod(directory, 0o700)
  let app: ChildProcess | undefined
  let proxy: ReturnType<typeof signallingHttpsProxy> | undefined
  let output = ''
  // Telemetry ingestion and the signalling inboxes share one proof slot per
  // Connector credential on the server and displace each other, so the upload
  // path stays closed until a spec asks for delivery. A `history` journey
  // keeps it open from the start and runs with the short proof lifetimes below.
  const liveHistory = options.history === true
  let telemetryUpload = liveHistory
  try {
    const farm = join(checkout, 'apps/farm')
    const layer = join(directory, 'layer')
    const built = join(layer, 'output')
    await mkdir(layer, { mode: 0o700 })
    // npm workspaces may hoist nuxt to the root; use whichever install the
    // farm workspace resolves instead of assuming apps/farm/node_modules.
    const nuxt = await resolveNuxtInstall(farm)
    await symlink(nuxt.nodeModules, join(layer, 'node_modules'), 'dir')
    await writeFile(
      join(layer, 'nuxt.config.ts'),
      `export default defineNuxtConfig({ extends: ${JSON.stringify(farm)}, srcDir: ${JSON.stringify(join(farm, 'app'))}, runtimeConfig: { connectorSignalling: { enabled: true } }, nitro: { preset: 'node-server', output: { dir: ${JSON.stringify(built)} } } })\n`,
      { mode: 0o600 },
    )
    const buildEnv = {
      ...process.env,
      BROWSERSLIST: 'defaults',
      NODE_ENV: 'production',
    }
    await run(
      process.execPath,
      [nuxt.cli, 'prepare'],
      { cwd: farm, env: buildEnv },
      300_000,
    )
    await run(
      process.execPath,
      [nuxt.cli, 'build'],
      { cwd: layer, env: buildEnv },
      900_000,
    )

    const cert = join(directory, 'cert.pem')
    const tlsKey = join(directory, 'tls-key.pem')
    execFileSync(
      'openssl',
      [
        ...['req', '-x509', '-newkey', 'rsa:2048', '-nodes'],
        ...['-keyout', tlsKey, '-out', cert, '-days', '1'],
        ...['-subj', '/CN=localhost'],
        ...['-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'],
      ],
      { stdio: 'ignore', timeout: 15_000 },
    )
    await chmod(cert, 0o600)
    await chmod(tlsKey, 0o600)

    const pairingKeys = generateKeyPairSync('ed25519')
    const signingKey = join(directory, 'signing.pem')
    const registry = join(directory, 'public.json')
    await writeFile(
      signingKey,
      pairingKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      { mode: 0o600 },
    )
    await writeFile(
      registry,
      JSON.stringify({
        fixture: pairingKeys.publicKey.export({ type: 'spki', format: 'pem' }),
      }),
      { mode: 0o600 },
    )

    const appPort = await freePort()
    proxy = signallingHttpsProxy({
      key: await readFile(tlsKey),
      cert: await readFile(cert),
      upstreamPort: appPort,
      unavailable: (path) =>
        !telemetryUpload && path.startsWith('/api/connector/telemetry'),
    })
    proxy.server.listen(0, '127.0.0.1')
    await once(proxy.server, 'listening')
    const address = proxy.server.address()
    if (!address || typeof address === 'string')
      throw new Error('TLS proxy port unavailable')
    const origin = `https://127.0.0.1:${address.port}`

    const configKeys = generateKeyPairSync('ed25519')
    const issuerKeyPath = join(directory, 'configuration-issuer.json')
    await writeFile(
      issuerKeyPath,
      JSON.stringify({
        version: 1,
        issuer: origin,
        kid: 'configuration-fixture',
        privateKeyPkcs8: configKeys.privateKey
          .export({ format: 'der', type: 'pkcs8' })
          .toString('base64url'),
      }),
      { mode: 0o600 },
    )
    const url = (index: number) => database.url(CAPABILITIES[index]!)
    // Signed control: the app issues capabilities with this key; the
    // Connector trusts only its public half (harness `control` option).
    const pauseKeys = generateKeyPairSync('ed25519')
    const pauseIssuerKeyPath = join(directory, 'pause-issuer.json')
    const pauseIssuerPublicKeySpki = pauseKeys.publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('base64url')
    await writeFile(
      pauseIssuerKeyPath,
      JSON.stringify({
        version: 1,
        issuer: origin,
        kid: PAUSE_KID,
        privateKeyPkcs8: pauseKeys.privateKey
          .export({ format: 'der', type: 'pkcs8' })
          .toString('base64url'),
      }),
      { mode: 0o600, flag: 'wx' },
    )
    // No renewal is configured: with telemetry flowing for the whole journey
    // the credential must outlive it.
    const tokenTtlSeconds = liveHistory ? '3600' : '300'
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OPEN3DFARM_CONFIGURATION: JSON.stringify({
        enabled: true,
        publicKeyRegistryPath: registry,
        proofDatabaseUrl: url(7),
        tokenTtlSeconds: Number(tokenTtlSeconds),
        proofTtlMs: 10000,
        databaseUrl: url(9),
        issuerKeyPath,
        issuerPublicKeySpki: configKeys.publicKey
          .export({ format: 'der', type: 'spki' })
          .toString('base64url'),
        issuer: origin,
        kid: 'configuration-fixture',
        audience: 'open3dfarmmanager:configuration',
        credentialIssuer: origin,
        credentialAudience: AUDIENCE,
      }),
      NITRO_HOST: '127.0.0.1',
      NITRO_PORT: String(appPort),
      NUXT_DATABASE_ENABLED: 'true',
      NUXT_DATABASE_DATABASE_URL: url(9),
      NUXT_DATABASE_MIGRATIONS: 'verify',
      NUXT_DATABASE_MIGRATIONS_DIR: join(checkout, 'infra/db/migrations'),
      NUXT_AUTH_ENABLED: 'true',
      NUXT_AUTH_ORIGIN: origin,
      NUXT_AUTH_SESSION_SECRET: randomBytes(32).toString('hex'),
      NUXT_AUTH_DATABASE_URL: url(0),
      NUXT_PRINTER_ASSIGNMENTS_ENABLED: 'true',
      NUXT_PRINTER_ASSIGNMENTS_DATABASE_URL: url(8),
      NUXT_CONNECTOR_INVENTORY_ENABLED: 'true',
      NUXT_CONNECTOR_INVENTORY_DATABASE_URL: url(1),
      NUXT_BROWSER_DEVICES_ENABLED: 'true',
      NUXT_BROWSER_DEVICES_DATABASE_URL: url(2),
      NUXT_CONNECTOR_PAIRING_ENABLED: 'true',
      NUXT_CONNECTOR_PAIRING_ORIGIN: origin,
      NUXT_CONNECTOR_PAIRING_DATABASE_URL: url(3),
      NUXT_CONNECTOR_PAIRING_PROOF_DATABASE_URL: url(4),
      NUXT_CONNECTOR_PAIRING_REVOCATION_DATABASE_URL: url(5),
      NUXT_CONNECTOR_PAIRING_AUDIENCE: AUDIENCE,
      NUXT_CONNECTOR_PAIRING_ISSUER: origin,
      NUXT_CONNECTOR_PAIRING_SIGNING_KEY_ID: 'fixture',
      NUXT_CONNECTOR_PAIRING_SIGNING_KEY_PATH: signingKey,
      NUXT_CONNECTOR_PAIRING_TOKEN_TTL_SECONDS: tokenTtlSeconds,
      NUXT_CONNECTOR_SIGNALLING_ENABLED: 'true',
      NUXT_CONNECTOR_SIGNALLING_ORIGIN: origin,
      NUXT_CONNECTOR_SIGNALLING_ISSUER: origin,
      NUXT_CONNECTOR_SIGNALLING_AUDIENCE: AUDIENCE,
      NUXT_CONNECTOR_SIGNALLING_READER_DATABASE_URL: url(6),
      NUXT_CONNECTOR_SIGNALLING_PROOF_DATABASE_URL: url(7),
      NUXT_CONNECTOR_SIGNALLING_PUBLIC_KEY_REGISTRY_PATH: registry,
      NUXT_CONNECTOR_SIGNALLING_TOKEN_TTL_SECONDS: tokenTtlSeconds,
      // With telemetry flowing next to both signalling sockets, a pending
      // proof answers the others "retry after its remaining lifetime": kept
      // well under the Connector's 8 s admission window, a collision is a
      // short wait and not a dropped socket.
      NUXT_CONNECTOR_SIGNALLING_PROOF_TTL_MS: liveHistory ? '3000' : '8000',
      NUXT_PAUSE_AUTHORITY_ENABLED: 'true',
      NUXT_PAUSE_AUTHORITY_DATABASE_URL: database.url('farm_pause_authority'),
      NUXT_PAUSE_AUTHORITY_ISSUER_KEY_PATH: pauseIssuerKeyPath,
      NUXT_PAUSE_AUTHORITY_ISSUER_PUBLIC_KEY_SPKI: pauseIssuerPublicKeySpki,
      NUXT_PAUSE_AUTHORITY_ISSUER: origin,
      NUXT_PAUSE_AUTHORITY_KID: PAUSE_KID,
      NUXT_PAUSE_AUTHORITY_AUDIENCE: PAUSE_AUDIENCE,
      NUXT_PAUSE_AUTHORITY_CREDENTIAL_ISSUER: origin,
      NUXT_PAUSE_AUTHORITY_CREDENTIAL_AUDIENCE: AUDIENCE,
      NUXT_CONNECTOR_TELEMETRY_ENABLED: 'true',
      NUXT_CONNECTOR_TELEMETRY_DATABASE_URL: database.url(
        'farm_connector_telemetry_writer',
      ),
      NUXT_CONNECTOR_TELEMETRY_ORIGIN: origin,
      NUXT_CONNECTOR_TELEMETRY_ISSUER: origin,
      NUXT_CONNECTOR_TELEMETRY_AUDIENCE: AUDIENCE,
      NUXT_CONNECTOR_TELEMETRY_PUBLIC_KEY_REGISTRY_PATH: registry,
      NUXT_CONNECTOR_TELEMETRY_TOKEN_TTL_SECONDS: tokenTtlSeconds,
      // One proof slot per credential is shared with the signalling inboxes:
      // a pending telemetry challenge makes them wait for its expiry, which
      // must stay well inside their admission windows. One second is too
      // short for the Connector to answer: nothing is ever delivered.
      NUXT_CONNECTOR_TELEMETRY_PROOF_TTL_MS: liveHistory ? '3000' : '2000',
      NUXT_CONNECTOR_TELEMETRY_BODY_TIMEOUT_MS: '5000',
      NUXT_JOB_HISTORY_ENABLED: 'true',
      NUXT_JOB_HISTORY_DATABASE_URL: database.url('farm_job_history_reader'),
    }
    delete env.NODE_TLS_REJECT_UNAUTHORIZED
    app = spawn(process.execPath, [join(built, 'server/index.mjs')], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    })
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-16384)
    }
    app.stdout?.on('data', collect)
    app.stderr?.on('data', collect)
    const deadline = Date.now() + 30_000
    for (;;) {
      if (app.exitCode !== null || app.signalCode !== null)
        throw new Error('Farm app exited before readiness\n' + output)
      try {
        const response = await fetch(`http://127.0.0.1:${appPort}/healthz`, {
          signal: AbortSignal.timeout(1000),
        })
        if (response.ok) break
      } catch {
        /* Bounded startup. */
      }
      if (Date.now() >= deadline)
        throw new Error('Farm app startup timed out\n' + output)
      await pause(100)
    }
    const owned = app
    const ownedProxy = proxy
    return Object.freeze({
      origin,
      certificatePath: cert,
      pauseIssuerPublicKeySpki,
      directory,
      log: () => output,
      disconnectUpgrades: () => ownedProxy.disconnectUpgrades(),
      setTelemetryUpload(open: boolean) {
        telemetryUpload = open
      },
      async close() {
        const failures: unknown[] = []
        for (const step of [
          () => stopChild(owned),
          () => ownedProxy.close(),
          () => rm(directory, { recursive: true, force: true }),
        ])
          try {
            await step()
          } catch (error) {
            failures.push(error)
          }
        if (failures.length) throw new Error('Farm app cleanup incomplete')
      },
    })
  } catch (error) {
    await stopChild(app).catch(() => {})
    await proxy?.close().catch(() => {})
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}
