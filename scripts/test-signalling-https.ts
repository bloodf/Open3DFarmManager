// Explicit opt-in synthetic fixture. It does not create a cluster or migrate a database.
import assert from 'node:assert/strict'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from 'node:crypto'
import { once } from 'node:events'
import { constants } from 'node:fs'
import {
  chmod,
  mkdir,
  lstat,
  readlink,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import postgres from 'postgres'
import { z } from '../packages/farm-protocol/node_modules/zod/index.js'
import { hashPassword } from '../apps/farm/server/utils/auth/password.ts'
import { signallingHttpsProxy } from '../tests/helpers/signalling-https-proxy.ts'
import { assertSignallingCatalog } from '../tests/helpers/signalling-https-catalog.ts'
import {
  requestProxyDisconnect,
  serveProxyDisconnect,
} from '../tests/helpers/signalling-https-disconnect-ipc.ts'
import type { SignallingFixtureExtension } from '../tests/helpers/signalling-https-fixture-contract.ts'
import {
  ARTIFACT_HEAD,
  assertArtifactSeal,
  assertSplitTrees,
} from '../tests/helpers/signalling-https-split-pin.ts'
import {
  Receipt,
  outputSnapshot,
  createFixtureReceipt,
} from '../tests/helpers/signalling-https-manifest.ts'
import {
  createFixtureCapture,
  observeFixtureClose,
  waitFixtureClose,
} from '../tests/helpers/signalling-https-process.ts'
import {
  createPauseAuthorityHttpsFixtureExtension,
  PauseHttpsIssuer,
} from '../tests/helpers/pause-authority-https-acceptance.ts'
import {
  createPauseAuditClient,
  createPauseDatabaseAudit,
  servePauseAudit,
  type PauseAuditPort,
} from '../tests/helpers/pause-authority-https-audit.ts'
import { runSignallingHttpsAcceptance } from '../tests/helpers/signalling-https-acceptance.ts'
import { loadMigrationCatalog } from './db/migrations.ts'

const checkout = await realpath(new URL('..', import.meta.url))
function outside(path: string) {
  const r = relative(checkout, path)
  return r.startsWith('../') || isAbsolute(r)
}
async function absoluteOutside(path: string) {
  if (!isAbsolute(path))
    throw new Error('An absolute private fixture path is required')
  const parent = await realpath(dirname(path))
  const resolved = join(parent, basename(path))
  if (!outside(resolved))
    throw new Error('Fixture path must be outside the checkout')
  return resolved
}
const Prebuild = Receipt.omit({ outputSha256: true, outputFiles: true })
function git(args: string[]) {
  return execFileSync('git', args, {
    cwd: checkout,
    timeout: 10000,
    maxBuffer: 4 * 1024 * 1024,
  }).toString('utf8')
}
async function sourceSnapshot() {
  if (git(['status', '--porcelain=v1', '--untracked-files=normal']).length)
    throw new Error('Source checkout must be clean')
  const head = git(['rev-parse', 'HEAD']).trim()
  const names = git(['ls-files', '-z']).split('\0').filter(Boolean).sort()
  if (!names.length || names.length > 10000)
    throw new Error('Invalid tracked source list')
  const hash = createHash('sha256')
  for (const name of names) {
    const path = join(checkout, name),
      stat = await lstat(path)
    if (stat.isSymbolicLink())
      hash.update(JSON.stringify([name, 'symlink', await readlink(path)]))
    else if (stat.isFile() && stat.size <= 64 * 1024 * 1024)
      hash.update(
        JSON.stringify([
          name,
          stat.mode & 0o777,
          stat.size,
          createHash('sha256')
            .update(await readFile(path))
            .digest('hex'),
        ]),
      )
    else throw new Error('Unexpected tracked source entry')
    hash.update('\n')
  }
  if (
    git(['status', '--porcelain=v1', '--untracked-files=normal']).length ||
    git(['rev-parse', 'HEAD']).trim() !== head
  )
    throw new Error('Source changed during snapshot')
  return { head, sourceSha256: hash.digest('hex') }
}
async function shaFile(path: string) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}
async function verifyReceipt(
  layer: string,
  receipt: z.infer<typeof Receipt>,
  expectedFixture?: { head: string; sourceSha256: string },
) {
  const source = await sourceSnapshot(),
    output = await outputSnapshot(join(layer, 'output'))
  const configSha256 = await shaFile(join(layer, 'nuxt.config.ts'))
  const manifest = await readFile(
    join(layer, 'fixture-output-files.json'),
    'utf8',
  )
  if (
    manifest.length > 2_000_000 ||
    manifest !== JSON.stringify(output.entries)
  )
    throw new Error('Built output file manifest mismatch')
  const { entries: _entries, ...summary } = output
  if (expectedFixture) {
    if (
      receipt.head !== ARTIFACT_HEAD ||
      JSON.stringify(source) !== JSON.stringify(expectedFixture)
    )
      throw new Error('Split source pin mismatch')
    assertSplitTrees(checkout, ARTIFACT_HEAD, expectedFixture.head)
    assertArtifactSeal({ configSha256, ...summary }, receipt)
  } else if (
    JSON.stringify({ ...source, configSha256, ...summary }) !==
    JSON.stringify(receipt)
  ) {
    throw new Error('Built output or source manifest mismatch')
  }
}
function auditPort(channel: ChildProcess | NodeJS.Process): PauseAuditPort {
  return {
    connected: () => channel.connected === true,
    send(value, callback) {
      if (!channel.send) throw new Error('Pause audit IPC unavailable')
      channel.send(value as object, undefined, undefined, callback)
    },
    onMessage(listener) {
      channel.on('message', listener)
      return () => {
        channel.off('message', listener)
      }
    },
    onDisconnect(listener) {
      channel.on('disconnect', listener)
      return () => {
        channel.off('disconnect', listener)
      }
    },
  }
}
function pauseExecutionClosure(): 'standard' | 'revocation' | 'disconnect' | 'stale' | 'reassigned' | 'peer-closed' | 'late-close' {
  const row = process.env.SIGNALLING_HTTPS_PAUSE_EXECUTION_ROW ?? 'standard'
  if (row !== 'standard' && row !== 'revocation' && row !== 'disconnect' && row !== 'stale' && row !== 'reassigned' && row !== 'peer-closed' && row !== 'late-close')
    throw new Error('Unknown pause execution row')
  return row
}
function fixtureMode() {
  const execution = process.env.SIGNALLING_HTTPS_PAUSE_EXECUTION_RTC_FIXTURE
  if (execution !== undefined &&
      (execution !== 'yes' || process.env.SIGNALLING_HTTPS_PAUSE_RTC_FIXTURE !== 'yes'))
    throw new Error('Execution fixture requires the maintained pause RTC opt-in')
  const flags = [
    process.env.SIGNALLING_HTTPS_RTC_FIXTURE,
    process.env.SIGNALLING_HTTPS_PAUSE_FIXTURE,
    process.env.SIGNALLING_HTTPS_PAUSE_RTC_FIXTURE,
  ]
  if (
    flags.some((value) => value !== undefined && value !== 'yes') ||
    flags.filter((value) => value === 'yes').length > 1
  )
    throw new Error('Invalid mutually exclusive fixture opt-in')
  return {
    rtcFixture: flags[0] === 'yes',
    pauseFixture: flags[1] === 'yes',
    pauseRtcFixture: flags[2] === 'yes',
  }
}
const mode = process.argv[2]
if (process.versions.bun || !process.versions.node.startsWith('24.'))
  throw new Error('Node 24 is required')
if (mode === '--prepare-layer') {
  if (process.argv.length !== 4 || !process.argv[3])
    throw new Error('Provide a new private layer directory')
  const source = await sourceSnapshot()
  const layer = await absoluteOutside(process.argv[3])
  await mkdir(layer, { mode: 0o700 })
  const app = join(checkout, 'apps/farm')
  const output = join(layer, 'output')
  await symlink(
    await realpath(join(app, 'node_modules')),
    join(layer, 'node_modules'),
    'dir',
  )
  const config = `export default defineNuxtConfig({ extends: ${JSON.stringify(app)}, srcDir: ${JSON.stringify(join(app, 'app'))}, runtimeConfig: { connectorSignalling: { enabled: true } }, nitro: { preset: 'node-server', output: { dir: ${JSON.stringify(output)} } } })\n`
  await writeFile(join(layer, 'nuxt.config.ts'), config, {
    mode: 0o600,
    flag: 'wx',
  })
  await writeFile(
    join(layer, 'prebuild.json'),
    JSON.stringify({
      ...source,
      configSha256: await shaFile(join(layer, 'nuxt.config.ts')),
    }),
    { mode: 0o600, flag: 'wx' },
  )
  console.log(
    JSON.stringify({
      layer,
      output,
      buildOptIn: true,
      runtime: 'not started',
      rtc: 'pending real client integration',
    }),
  )
} else if (mode === '--seal-build') {
  if (process.argv.length !== 4 || !process.argv[3])
    throw new Error('Provide the prepared private layer')
  const layer = await realpath(process.argv[3])
  if (!outside(layer)) throw new Error('Layer must be outside checkout')
  const initial = Prebuild.parse(
    JSON.parse(await readFile(join(layer, 'prebuild.json'), 'utf8')),
  )
  const source = await sourceSnapshot(),
    configSha256 = await shaFile(join(layer, 'nuxt.config.ts'))
  if (JSON.stringify({ ...source, configSha256 }) !== JSON.stringify(initial))
    throw new Error('Build input changed since preparation')
  const { entries, receipt } = await createFixtureReceipt(
    join(layer, 'output'),
    source,
    configSha256,
  )
  await writeFile(
    join(layer, 'fixture-output-files.json'),
    JSON.stringify(entries),
    { mode: 0o600, flag: 'wx' },
  )
  await writeFile(
    join(layer, 'fixture-build-receipt.json'),
    JSON.stringify(receipt),
    { mode: 0o600, flag: 'wx' },
  )
  console.log(
    JSON.stringify({
      head: receipt.head,
      outputSha256: receipt.outputSha256,
      outputFiles: receipt.outputFiles,
    }),
  )
} else if (mode === '--accept') {
  if (
    process.argv.length !== 3 ||
    process.env.SIGNALLING_HTTPS_DISPOSABLE !== 'yes'
  )
    throw new Error('Explicit disposable fixture required')
  const {
    SIGNALLING_HTTPS_ORIGIN: origin,
    SIGNALLING_HTTPS_CA: ca,
    SIGNALLING_HTTPS_FARM: farmId,
    SIGNALLING_HTTPS_OWNER: owner,
    SIGNALLING_HTTPS_ADMIN: admin,
    SIGNALLING_HTTPS_PASSWORD: password,
  } = process.env
  if (!origin || !ca || !farmId || !owner || !admin || !password)
    throw new Error('Missing disposable acceptance fixture')
  const { rtcFixture, pauseFixture, pauseRtcFixture } = fixtureMode()
  const extensionPath = '../tests/helpers/signalling-authenticated-rtc.ts'
  const extensionModule:
    | { createAuthenticatedRtcFixtureExtension(): SignallingFixtureExtension }
    | undefined = rtcFixture ? await import(extensionPath) : undefined
  const executionModule = process.env.SIGNALLING_HTTPS_PAUSE_EXECUTION_RTC_FIXTURE === 'yes'
    ? await import('../tests/helpers/pause-execution-rtc.ts')
    : undefined
  const pauseRtcModule = pauseRtcFixture && !executionModule
    ? await import('../tests/helpers/pause-authenticated-rtc.ts')
    : undefined
  const pauseAudit = pauseFixture
    ? createPauseAuditClient(auditPort(process))
    : undefined
  const pauseExtension = pauseAudit
    ? createPauseAuthorityHttpsFixtureExtension({
        ...PauseHttpsIssuer.parse({
          issuer: origin,
          kid: 'pause-fixture',
          audience: 'open3dfarmmanager:pause',
          publicKeySpki: process.env.SIGNALLING_HTTPS_PAUSE_PUBLIC_KEY,
        }),
        audit: (request) => pauseAudit.request(request),
      })
    : undefined
  try {
    console.log(
      JSON.stringify(
        await runSignallingHttpsAcceptance({
          origin,
          ca: await readFile(ca),
          farmId,
          owner,
          admin,
          password,
          ...(pauseExtension
            ? {
                extension: pauseExtension,
                extensionKind: 'pause-authority' as const,
                caPath: ca,
                disconnectSignalling: async () => {
                  throw new Error('Pause fixture must not use signalling')
                },
              }
            : {}),
          ...(executionModule
            ? {
                extension: executionModule.createPauseExecutionRtcFixtureExtension({
                  closure: pauseExecutionClosure(),
                  testReplay: true,
                }),
                extensionKind: 'pause-execution-rtc' as const,
                caPath: ca,
                disconnectSignalling: requestProxyDisconnect,
              }
            : {}),
          ...(pauseRtcModule
            ? {
                extension:
                  pauseRtcModule.createPauseAuthenticatedRtcFixtureExtension(),
                extensionKind: 'pause-rtc' as const,
                caPath: ca,
                disconnectSignalling: requestProxyDisconnect,
              }
            : {}),
          ...(extensionModule
            ? {
                extension:
                  extensionModule.createAuthenticatedRtcFixtureExtension(),
                caPath: ca,
                disconnectSignalling: requestProxyDisconnect,
              }
            : {}),
        }),
      ),
    )
  } finally {
    pauseAudit?.close()
    if ((rtcFixture || pauseFixture || pauseRtcFixture) && process.connected)
      process.disconnect()
  }
} else if (mode === '--run') {
  if (
    process.argv.length !== 3 ||
    process.env.SIGNALLING_HTTPS_DISPOSABLE !== 'yes'
  )
    throw new Error('Explicit disposable fixture required')
  const { rtcFixture, pauseFixture, pauseRtcFixture } = fixtureMode()
  const portText = process.env.SIGNALLING_HTTPS_PORT,
    port = Number(portText)
  const requestedLedger = process.env.SIGNALLING_HTTPS_LEDGER
  const requestedLayer = process.env.SIGNALLING_HTTPS_LAYER
  if (
    !portText ||
    !/^\d{4,5}$/.test(portText) ||
    port < 1024 ||
    port > 65535 ||
    !requestedLedger ||
    !requestedLayer
  )
    throw new Error('Missing explicit disposable fixture or sealed build')
  const layer = await realpath(requestedLayer)
  if (!outside(layer)) throw new Error('Layer must be outside checkout')
  const receipt = Receipt.parse(
    JSON.parse(
      await readFile(join(layer, 'fixture-build-receipt.json'), 'utf8'),
    ),
  )
  const requestedFixtureHead = process.env.SIGNALLING_HTTPS_SPLIT_FIXTURE_HEAD
  const fixtureSource = requestedFixtureHead
    ? await sourceSnapshot()
    : undefined
  if (fixtureSource && fixtureSource.head !== requestedFixtureHead)
    throw new Error('Fixture head mismatch')
  await verifyReceipt(layer, receipt, fixtureSource)
  const head = receipt.head
  const entry = join(layer, 'output/server/index.mjs')
  const actualHash = await shaFile(entry)
  const ledgerPath = await absoluteOutside(requestedLedger)
  const ledger = await open(
    ledgerPath,
    constants.O_APPEND |
      constants.O_CREAT |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  )
  await ledger.chmod(0o600)
  const note = (text: string) =>
    ledger.appendFile(`${new Date().toISOString()} ${text}\n`)
  const sql = postgres({
    host: '127.0.0.1',
    port,
    database: 'fixture',
    username: 'fixture',
    max: 2,
    connect_timeout: 3,
    connection: { statement_timeout: 3000, lock_timeout: 1000 },
  })
  const prefix = 'signal_http_' + randomUUID().replaceAll('-', '')
  const capabilities = [
    'farm_password_auth',
    'farm_connector_inventory',
    'farm_browser_device_runtime',
    'farm_pairing_runtime',
    'farm_pairing_proof_runtime',
    'farm_connector_revoker',
    'farm_signalling_reader',
    'farm_connector_credential_acceptor',
    ...(rtcFixture || pauseFixture || pauseRtcFixture
      ? ['farm_printer_ownership']
      : []),
    ...(pauseFixture || pauseRtcFixture ? ['farm_pause_authority'] : []),
  ] as const
  const roles = capabilities.map((_, index) => `${prefix}_${index}`)
  const secrets = roles.map(() => randomBytes(24).toString('hex'))
  const password = randomBytes(24).toString('hex'),
    ownerId = randomUUID(),
    adminId = randomUUID(),
    farmId = randomUUID()
  const owner = 'owner_' + randomBytes(8).toString('hex'),
    admin = 'admin_' + randomBytes(8).toString('hex')
  const created: string[] = []
  let directory: string | undefined,
    app: ChildProcess | undefined,
    child: ChildProcess | undefined
  let closePauseAudit: (() => Promise<void>) | undefined
  let appClose: Promise<unknown[]> | undefined,
    childClose: Promise<unknown[]> | undefined
  let proxy: ReturnType<typeof signallingHttpsProxy> | undefined
  let stage = 'journal validation',
    failed = false,
    interrupted = false
  const captured = createFixtureCapture()
  const privateValues = [
    ...secrets,
    password,
    owner,
    admin,
    ownerId,
    adminId,
    farmId,
  ]
  const interrupt = () => {
    interrupted = true
    app?.kill('SIGTERM')
    if (child?.pid) {
      try {
        globalThis.process.kill(-child.pid, 'SIGTERM')
      } catch {
        /* already exited */
      }
    }
  }
  const checkInterrupt = () => {
    if (interrupted) throw new Error('Fixture interrupted')
  }
  globalThis.process.once('SIGINT', interrupt)
  globalThis.process.once('SIGTERM', interrupt)
  function sanitizedLogs() {
    return captured
      .entries()
      .map(([source, original]) => {
        let text = original
        for (const value of privateValues)
          text = text.replaceAll(value, '[synthetic]')
        text = text
          .replace(
            /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g,
            '[private-key]',
          )
          .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[database-url]')
          .replace(/(?:set-cookie|cookie|authorization):[^\r\n]*/gi, '[header]')
          .replace(/[A-Za-z0-9_+\/=.-]{32,}/g, '[long-value]')
        return [
          `[${source}]`,
          Buffer.from(text).subarray(0, 16380).toString('utf8'),
        ].join('\n')
      })
      .join('\n')
  }
  const pause = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms))
  async function stop(process: ChildProcess | undefined, group: boolean) {
    if (!process?.pid) return
    const alive = () => process.exitCode === null && process.signalCode === null
    const groupExists = () => {
      try {
        globalThis.process.kill(-process.pid!, 0)
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
        throw error
      }
    }
    if (!alive()) {
      if (group && groupExists())
        throw new Error(
          'Unverified descendants remain in completed process group',
        )
      return
    }
    const signal = (name: NodeJS.Signals) => {
      try {
        if (group) globalThis.process.kill(-process.pid!, name)
        else process.kill(name)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    signal('SIGTERM')
    if (alive()) await Promise.race([once(process, 'exit'), pause(3000)])
    // A surviving group after its leader exits has no verified owned members.
    if (alive()) signal('SIGKILL')
    if (alive()) await Promise.race([once(process, 'exit'), pause(3000)])
    if (alive() || (group && groupExists()))
      throw new Error('Fixture child or owned group did not exit')
  }

  try {
    await note(
      `Artifact HEAD ${head}; fixture HEAD ${fixtureSource?.head ?? head}; fixture source SHA256 ${fixtureSource?.sourceSha256 ?? receipt.sourceSha256}; isolated built entry SHA256 ${actualHash}; fixture port ${port}`,
    )
    const actor = (
      await sql`SELECT current_database() AS db,current_user AS actor`
    )[0]
    assert.equal(actor?.db, 'fixture')
    assert.equal(actor?.actor, 'fixture')
    const catalog = await loadMigrationCatalog()
    const history =
      await sql`SELECT position,id,checksum FROM public.open3dfarm_migrations ORDER BY position`
    const appliedCount = assertSignallingCatalog(
      catalog,
      [...history],
      rtcFixture || pauseFixture || pauseRtcFixture,
    )
    if (
      (pauseFixture || pauseRtcFixture) &&
      catalog[17]?.id !== '0018_pause_authority'
    )
      throw new Error('Pause authority official migration required')
    await note(
      `Official catalog and journal count ${appliedCount}; fixture source HEAD ${fixtureSource?.head ?? head}`,
    )
    await note(`Verified official journal ${JSON.stringify(history)}`)
    checkInterrupt()
    stage = 'restricted fixture setup'
    for (const [index, role] of roles.entries()) {
      const secret = secrets[index]!,
        capability = capabilities[index]!
      if ((await sql`SELECT 1 FROM pg_roles WHERE rolname=${role}`).length)
        throw new Error('Fixture role collision')
      await note(`Reserved owned fixture role ${role}`)
      created.push(role)
      await sql.unsafe(
        `CREATE ROLE ${role} LOGIN PASSWORD '${secret}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE ${capability}`,
      )
    }
    const hash = await hashPassword(password)
    for (const [id, name] of [
      [ownerId, owner],
      [adminId, admin],
    ] as const) {
      await sql`INSERT INTO farm.session_accounts(id) VALUES(${id})`
      await sql`INSERT INTO farm.password_credentials(account_id,username,password_hash) VALUES(${id},${name},${hash})`
    }
    await sql`INSERT INTO farm.farms(id) VALUES(${farmId}::uuid)`
    await sql`INSERT INTO farm.memberships(farm_id,account_id,role) VALUES(${farmId}::uuid,${ownerId},'owner'),(${farmId}::uuid,${adminId},'admin')`
    await note(`Owned restricted fixture roles ${roles.join(',')}`)
    directory = await mkdtemp(join(tmpdir(), 'o3dfarm-signal-https-'))
    await chmod(directory, 0o700)
    await note(`Owned private fixture directory ${directory}`)
    const cert = join(directory, 'cert.pem'),
      tlsKey = join(directory, 'tls-key.pem')
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        tlsKey,
        '-out',
        cert,
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
      ],
      { stdio: 'ignore', timeout: 15000 },
    )
    await chmod(cert, 0o600)
    await chmod(tlsKey, 0o600)
    const signing = generateKeyPairSync('ed25519'),
      signingKey = join(directory, 'signing.pem'),
      registry = join(directory, 'public.json')
    await writeFile(
      signingKey,
      signing.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      { mode: 0o600, flag: 'wx' },
    )
    await writeFile(
      registry,
      JSON.stringify({
        fixture: signing.publicKey.export({ type: 'spki', format: 'pem' }),
      }),
      { mode: 0o600, flag: 'wx' },
    )
    const reservation = createServer()
    reservation.listen(0, '127.0.0.1')
    await once(reservation, 'listening')
    const address = reservation.address()
    if (!address || typeof address === 'string')
      throw new Error('Fixture app port unavailable')
    const appPort = address.port
    await new Promise<void>((resolve, reject) =>
      reservation.close((error) => (error ? reject(error) : resolve())),
    )
    proxy = signallingHttpsProxy({
      key: await readFile(tlsKey),
      cert: await readFile(cert),
      upstreamPort: appPort,
    })
    proxy.server.listen(0, '127.0.0.1')
    await once(proxy.server, 'listening')
    const proxyAddress = proxy.server.address()
    if (!proxyAddress || typeof proxyAddress === 'string')
      throw new Error('Fixture TLS port unavailable')
    const origin = `https://127.0.0.1:${proxyAddress.port}`,
      audience = 'open3dfarmmanager:signalling',
      sessionSecret = randomBytes(32).toString('hex')
    privateValues.push(sessionSecret)
    let pauseIssuer: { path: string; publicKeySpki: string } | undefined
    if (pauseFixture || pauseRtcFixture) {
      const keys = generateKeyPairSync('ed25519')
      const privateKeyPkcs8 = keys.privateKey
        .export({ format: 'der', type: 'pkcs8' })
        .toString('base64url')
      const publicKeySpki = keys.publicKey
        .export({ format: 'der', type: 'spki' })
        .toString('base64url')
      const path = join(directory, 'pause-issuer.json')
      const content = JSON.stringify({
        version: 1,
        issuer: origin,
        kid: 'pause-fixture',
        privateKeyPkcs8,
      })
      if (Buffer.byteLength(content) > 4096)
        throw new Error('Pause issuer file exceeded bound')
      privateValues.push(privateKeyPkcs8)
      await writeFile(path, content, { mode: 0o600, flag: 'wx' })
      pauseIssuer = { path, publicKeySpki }
    }
    const dbUrl = (index: number) =>
      `postgres://${roles[index]}:${secrets[index]}@127.0.0.1:${port}/fixture`
    const env = { ...process.env }
    delete env.NODE_TLS_REJECT_UNAUTHORIZED
    checkInterrupt()
    stage = 'generated Nitro startup'
    app = spawn(process.execPath, [entry], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...env,
        NITRO_HOST: '127.0.0.1',
        NITRO_PORT: String(appPort),
        NUXT_AUTH_ENABLED: 'true',
        NUXT_AUTH_ORIGIN: origin,
        NUXT_AUTH_SESSION_SECRET: sessionSecret,
        NUXT_AUTH_DATABASE_URL: dbUrl(0),
        ...(rtcFixture || pauseFixture || pauseRtcFixture
          ? {
              NUXT_PRINTER_ASSIGNMENTS_ENABLED: 'true',
              NUXT_PRINTER_ASSIGNMENTS_DATABASE_URL: dbUrl(8),
              NUXT_PUBLIC_FLAGS_FARM_VIEW:
                process.env.SIGNALLING_HTTPS_FARM_PAGE === 'yes'
                  ? 'true'
                  : 'false',
            }
          : {}),
        ...(pauseIssuer
          ? {
              NUXT_PAUSE_AUTHORITY_ENABLED: 'true',
              NUXT_PAUSE_AUTHORITY_DATABASE_URL: dbUrl(9),
              NUXT_PAUSE_AUTHORITY_ISSUER_KEY_PATH: pauseIssuer.path,
              NUXT_PAUSE_AUTHORITY_ISSUER_PUBLIC_KEY_SPKI:
                pauseIssuer.publicKeySpki,
              NUXT_PAUSE_AUTHORITY_ISSUER: origin,
              NUXT_PAUSE_AUTHORITY_KID: 'pause-fixture',
              NUXT_PAUSE_AUTHORITY_AUDIENCE: 'open3dfarmmanager:pause',
              NUXT_PAUSE_AUTHORITY_CREDENTIAL_ISSUER: origin,
              NUXT_PAUSE_AUTHORITY_CREDENTIAL_AUDIENCE: audience,
            }
          : {}),
        NUXT_CONNECTOR_INVENTORY_ENABLED: 'true',
        NUXT_CONNECTOR_INVENTORY_DATABASE_URL: dbUrl(1),
        NUXT_BROWSER_DEVICES_ENABLED: 'true',
        NUXT_BROWSER_DEVICES_DATABASE_URL: dbUrl(2),
        NUXT_CONNECTOR_PAIRING_ENABLED: 'true',
        NUXT_CONNECTOR_PAIRING_ORIGIN: origin,
        NUXT_CONNECTOR_PAIRING_DATABASE_URL: dbUrl(3),
        NUXT_CONNECTOR_PAIRING_PROOF_DATABASE_URL: dbUrl(4),
        NUXT_CONNECTOR_PAIRING_REVOCATION_DATABASE_URL: dbUrl(5),
        NUXT_CONNECTOR_PAIRING_AUDIENCE: audience,
        NUXT_CONNECTOR_PAIRING_ISSUER: origin,
        NUXT_CONNECTOR_PAIRING_SIGNING_KEY_ID: 'fixture',
        NUXT_CONNECTOR_PAIRING_SIGNING_KEY_PATH: signingKey,
        NUXT_CONNECTOR_PAIRING_TOKEN_TTL_SECONDS: '300',
        NUXT_CONNECTOR_SIGNALLING_ENABLED: pauseFixture ? 'false' : 'true',
        NUXT_CONNECTOR_SIGNALLING_ORIGIN: origin,
        NUXT_CONNECTOR_SIGNALLING_ISSUER: origin,
        NUXT_CONNECTOR_SIGNALLING_AUDIENCE: audience,
        NUXT_CONNECTOR_SIGNALLING_READER_DATABASE_URL: dbUrl(6),
        NUXT_CONNECTOR_SIGNALLING_PROOF_DATABASE_URL: dbUrl(7),
        NUXT_CONNECTOR_SIGNALLING_PUBLIC_KEY_REGISTRY_PATH: registry,
        NUXT_CONNECTOR_SIGNALLING_TOKEN_TTL_SECONDS: '300',
        NUXT_CONNECTOR_SIGNALLING_PROOF_TTL_MS: '8000',
      },
    })
    appClose = observeFixtureClose(app)
    app.stdout?.on('data', (chunk: Buffer) =>
      captured.append('nitro.stdout', chunk),
    )
    app.stderr?.on('data', (chunk: Buffer) =>
      captured.append('nitro.stderr', chunk),
    )
    await note(
      `Owned Nitro PID ${app.pid}; TLS proxy port ${proxyAddress.port}; Nitro port ${appPort}`,
    )
    const deadline = Date.now() + 20000
    while (true) {
      checkInterrupt()
      if (!app.pid || app.exitCode !== null || app.signalCode !== null)
        throw new Error('Nitro exited before readiness')
      try {
        if (
          (
            await fetch(`http://127.0.0.1:${appPort}/healthz`, {
              signal: AbortSignal.timeout(1000),
            })
          ).ok
        )
          break
      } catch {
        /* bounded startup */
      }
      if (Date.now() >= deadline) throw new Error('Nitro startup timed out')
      await pause(100)
    }
    stage = 'real HTTPS and WSS acceptance'
    child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        join(checkout, 'scripts/test-signalling-https.ts'),
        '--accept',
      ],
      {
        detached: true,
        stdio:
          rtcFixture || pauseFixture || pauseRtcFixture
            ? ['ignore', 'pipe', 'pipe', 'ipc']
            : ['ignore', 'pipe', 'pipe'],
        env: {
          ...env,
          NODE_EXTRA_CA_CERTS: cert,
          WS_NO_BUFFER_UTIL: '1',
          WS_NO_UTF_8_VALIDATE: '1',
          SIGNALLING_HTTPS_DISPOSABLE: 'yes',
          SIGNALLING_HTTPS_ORIGIN: origin,
          SIGNALLING_HTTPS_CA: cert,
          SIGNALLING_HTTPS_FARM: farmId,
          SIGNALLING_HTTPS_OWNER: owner,
          SIGNALLING_HTTPS_ADMIN: admin,
          SIGNALLING_HTTPS_PASSWORD: password,
          ...(rtcFixture ? { SIGNALLING_HTTPS_RTC_FIXTURE: 'yes' } : {}),
          ...(pauseRtcFixture
            ? { SIGNALLING_HTTPS_PAUSE_RTC_FIXTURE: 'yes',
                ...(process.env.SIGNALLING_HTTPS_PAUSE_EXECUTION_RTC_FIXTURE === 'yes'
                  ? { SIGNALLING_HTTPS_PAUSE_EXECUTION_RTC_FIXTURE: 'yes',
                      SIGNALLING_HTTPS_PAUSE_EXECUTION_ROW: pauseExecutionClosure() } : {}) }
            : {}),
          ...(pauseIssuer
            ? {
                ...(pauseFixture
                  ? { SIGNALLING_HTTPS_PAUSE_FIXTURE: 'yes' }
                  : {}),
                SIGNALLING_HTTPS_PAUSE_PUBLIC_KEY: pauseIssuer.publicKeySpki,
              }
            : {}),
        },
      },
    )
    childClose = observeFixtureClose(child)
    if (pauseFixture) {
      const audit = createPauseDatabaseAudit(sql, {
        farmId,
        accountId: ownerId,
      })
      closePauseAudit = servePauseAudit(auditPort(child), async (request) => {
        const receipt = await audit(request)
        await note(
          `Pause audit ${JSON.stringify({ stage: request.stage, rows: receipt.rows, issued: receipt.issued, attempts: receipt.attempts, status: receipt.row?.status ?? null, scopeMatches: receipt.row?.scopeMatches ?? null, revokedSession: receipt.row?.revokedSession ?? null, expectedHashMatches: receipt.row?.expectedHashMatches ?? null })}`,
        )
        return receipt
      })
    }
    if (rtcFixture || pauseRtcFixture)
      serveProxyDisconnect(child, () => proxy!.disconnectUpgrades())
    child.stdout?.on('data', (chunk: Buffer) =>
      captured.append('acceptance.stdout', chunk),
    )
    child.stderr?.on('data', (chunk: Buffer) =>
      captured.append('acceptance.stderr', chunk),
    )
    if (!child.pid) throw new Error('Acceptance process did not start')
    await note(`Owned acceptance process group ${child.pid}`)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        childClose.then(([code, signal]) => ({ code, signal })),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Acceptance timed out')),
            180000,
          )
        }),
      ])
      checkInterrupt()
      await note(
        `Acceptance drained: exit ${result.code}, signal ${result.signal ?? 'none'}`,
      )
      if (result.code !== 0 || result.signal)
        throw new Error('HTTPS/WSS acceptance failed')
    } finally {
      clearTimeout(timer)
    }
    stage = 'complete'
  } catch {
    failed = true
    await note(`FAIL during ${stage}; sanitized bounded diagnostics retained`)
  } finally {
    const failures: string[] = []
    const cleanup = async (name: string, action: () => Promise<void>) => {
      try {
        await action()
      } catch {
        failures.push(name)
      }
    }
    await cleanup('source and artifact manifest', () =>
      verifyReceipt(layer, receipt, fixtureSource),
    )
    await cleanup('acceptance process group', () => stop(child, true))
    await cleanup('Nitro process', () => stop(app, false))
    if (closePauseAudit)
      await cleanup('pause audit settlement', closePauseAudit)
    for (const [name, closed] of [
      ['acceptance', childClose],
      ['Nitro', appClose],
    ] as const) {
      if (closed)
        await cleanup(`${name} stream drainage`, async () => {
          await waitFixtureClose(closed, 3000)
        })
    }
    if (proxy) await cleanup('TLS proxy', () => proxy!.close())
    for (const role of created.reverse())
      await cleanup('fixture role', async () => {
        await sql`DROP ROLE IF EXISTS ${sql(role)}`
      })
    await cleanup('database connection', () => sql.end({ timeout: 3 }))
    if (directory)
      await cleanup('private fixture directory', () =>
        rm(directory!, { recursive: true, force: true }),
      )
    if (captured.entries().length)
      await cleanup('sanitized app log', () =>
        writeFile(ledgerPath + '.app-log.txt', sanitizedLogs(), {
          mode: 0o600,
        }),
      )
    await note(
      `Cleanup ${failures.length ? 'incomplete: ' + failures.join(',') : 'complete'}; caller owns disposable database rows`,
    )
    if (!failed && !failures.length)
      await note(
        pauseRtcFixture
          ? 'PASS real generated Nitro HTTPS pause issuer and authenticated pause RTC fixture'
          : pauseFixture
            ? 'PASS real generated Nitro HTTPS pause issuer; synthetic control proofs, no RTC or command execution'
            : rtcFixture
              ? 'PASS real generated Nitro HTTPS/WSS admission and authenticated RTC status/closure fixture'
              : 'PASS real generated Nitro HTTPS/WSS signalling admission; RTC client integration remains pending',
      )
    await ledger.close()
    globalThis.process.removeListener('SIGINT', interrupt)
    globalThis.process.removeListener('SIGTERM', interrupt)
    if (failed || failures.length) process.exitCode = 1
  }
} else {
  throw new Error(
    'Use --prepare-layer, --seal-build or --run with an explicit disposable fixture',
  )
}
