// Disposable fixture helper. The caller owns the directory and isolated database.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createServer as createTcpServer } from 'node:net'
import { createServer as createHttpsServer } from 'node:https'
import { request as requestHttp } from 'node:http'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { join, resolve } from 'node:path'

export async function startBuiltTelemetryFixture(input: {
  directory: string
  keyFile: string
  sqlPort: number
  sqlUser: string
  issuer: string
  audience: string
  ledgerPath: string
}) {
  const cert = join(input.directory, 'tls-cert.pem'),
    privateKey = join(input.directory, 'tls-key.pem')
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      privateKey,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { stdio: 'ignore', timeout: 10000 },
  )
  const reservation = createTcpServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const address = reservation.address()
  if (!address || typeof address === 'string')
    throw new Error('Missing local listener')
  const appPort = address.port
  await new Promise<void>((resolveClose, reject) =>
    reservation.close((error) => (error ? reject(error) : resolveClose())),
  )
  let drop = true
  const proxy = createHttpsServer(
    { key: await readFile(privateKey), cert: await readFile(cert) },
    (req, res) => {
      const upstream = requestHttp(
        {
          host: '127.0.0.1',
          port: appPort,
          method: req.method,
          path: req.url,
          headers: { ...req.headers, host: `127.0.0.1:${appPort}` },
        },
        (response) => {
          if (
            req.url === '/api/connector/telemetry' &&
            response.statusCode === 200 &&
            drop
          ) {
            drop = false
            response.resume()
            response.once('end', () => res.destroy())
            return
          }
          res.writeHead(response.statusCode ?? 502, response.headers)
          response.pipe(res)
        },
      )
      upstream.on('error', () => res.destroy())
      req.on('error', () => upstream.destroy())
      req.pipe(upstream)
    },
  )
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  const proxyAddress = proxy.address()
  if (!proxyAddress || typeof proxyAddress === 'string')
    throw new Error('Missing TLS listener')
  const origin = `https://127.0.0.1:${proxyAddress.port}`
  await appendFile(
    input.ledgerPath,
    JSON.stringify({
      resource: 'loopback-proxy',
      port: proxyAddress.port,
      appPort,
    }) + '\n',
    { mode: 0o600 },
  )
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    NODE_ENV: 'production',
    NITRO_HOST: '127.0.0.1',
    NITRO_PORT: String(appPort),
    NUXT_CONNECTOR_TELEMETRY_ENABLED: 'true',
    NUXT_CONNECTOR_TELEMETRY_DATABASE_URL: `postgres://${encodeURIComponent(input.sqlUser)}:synthetic@127.0.0.1:${input.sqlPort}/fixture`,
    NUXT_CONNECTOR_TELEMETRY_ORIGIN: origin,
    NUXT_CONNECTOR_TELEMETRY_ISSUER: input.issuer,
    NUXT_CONNECTOR_TELEMETRY_AUDIENCE: input.audience,
    NUXT_CONNECTOR_TELEMETRY_PUBLIC_KEY_REGISTRY_PATH: input.keyFile,
    NUXT_CONNECTOR_TELEMETRY_TOKEN_TTL_SECONDS: '300',
    NUXT_CONNECTOR_TELEMETRY_PROOF_TTL_MS: '30000',
    NUXT_CONNECTOR_TELEMETRY_BODY_TIMEOUT_MS: '5000',
  }
  const app = spawn(
    process.execPath,
    [resolve('apps/farm/.output/server/index.mjs')],
    { env, stdio: 'ignore' },
  )
  await appendFile(
    input.ledgerPath,
    JSON.stringify({ resource: 'built-app-process', pid: app.pid }) + '\n',
    { mode: 0o600 },
  )
  async function stopApp(processToStop: ChildProcess) {
    if (processToStop.exitCode !== null || processToStop.signalCode !== null)
      return
    processToStop.kill('SIGTERM')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        once(processToStop, 'exit'),
        new Promise<void>((resolveWait) => {
          timer = setTimeout(() => {
            processToStop.kill('SIGKILL')
            resolveWait()
          }, 3000)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  async function close() {
    proxy.closeAllConnections()
    await new Promise<void>((resolveClose) => proxy.close(() => resolveClose()))
    await stopApp(app)
  }
  try {
    const deadline = Date.now() + 10000
    while (true) {
      if (app.exitCode !== null || app.signalCode !== null)
        throw new Error('Built app exited during startup')
      try {
        const response = await fetch(`http://127.0.0.1:${appPort}/healthz`, {
          signal: AbortSignal.timeout(500),
          redirect: 'error',
        })
        if (response.ok) break
      } catch {
        /* bounded readiness polling */
      }
      if (Date.now() >= deadline)
        throw new Error('Built app did not become ready')
      await new Promise((resolveWait) => setTimeout(resolveWait, 50))
    }
  } catch (error) {
    await close()
    throw error
  }
  return {
    origin,
    async runClient(
      fixture: {
        token: string
        agentId: string
        farmId: string
        privateKey: string
      },
      phase: 'deliver' | 'revoked',
    ) {
      const path = join(input.directory, 'client.json')
      await writeFile(
        path,
        JSON.stringify({
          ...fixture,
          endpoint: origin + '/api/connector/telemetry',
          audience: input.audience,
          queueDir: join(input.directory, 'built-queue'),
        }),
        { mode: 0o600 },
      )
      const child = spawn(
        process.execPath,
        [
          '--experimental-transform-types',
          '--disable-warning=ExperimentalWarning',
          resolve('scripts/test-telemetry-http-built-client.ts'),
        ],
        {
          env: {
            PATH: env.PATH,
            NODE_EXTRA_CA_CERTS: cert,
            TELEMETRY_HTTP_BUILT_FIXTURE: path,
            TELEMETRY_HTTP_BUILT_PHASE: phase,
          },
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      )
      await appendFile(
        input.ledgerPath,
        JSON.stringify({
          resource: 'built-client-process',
          pid: child.pid,
          phase,
        }) + '\n',
        { mode: 0o600 },
      )
      let output = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        output += chunk
        if (output.length > 4096) child.kill('SIGKILL')
      })
      const timeout = setTimeout(() => child.kill('SIGKILL'), 15000)
      try {
        const [code] = await once(child, 'exit')
        if (code !== 0 || output.length > 4096)
          throw new Error('Synthetic built client failed')
        const value: unknown = JSON.parse(output)
        if (
          !value ||
          typeof value !== 'object' ||
          !('phase' in value) ||
          value.phase !== phase ||
          !('eventId' in value) ||
          typeof value.eventId !== 'string'
        )
          throw new Error('Invalid synthetic client result')
        return value.eventId
      } finally {
        clearTimeout(timeout)
      }
    },
    close,
  }
}
