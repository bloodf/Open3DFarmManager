import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import {
  createServer as createHttpsServer,
  request as httpsRequest,
} from 'node:https'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { seedSandbox } from '../../scripts/sandbox-seed.ts'
import {
  disposablePostgres,
  findPostgresBin,
  getFreePort,
} from '../helpers/disposable-postgres.ts'
import { startMoonrakerMock } from '../../packages/sim-tools/src/mocks/moonraker-mock.ts'
import { startBambuSimulator } from '../../packages/sim-tools/src/bambu-simulator.ts'
import { syntheticBambuTls } from '../../infra/sandbox/bambu-synthetic-identity.ts'

let missing = ''
try {
  findPostgresBin()
} catch (error) {
  missing = String(error)
}
if (missing && process.env.CI) throw new Error(missing)
if (missing) console.warn(`SKIP sandbox integration: ${missing}`)

test(
  'sandbox jobs use a paired simulator and retain machine hours',
  { skip: missing || false, timeout: 180_000 },
  async () => {
    const production = await readFile('apps/farm/nuxt.config.ts', 'utf8')
    assert.match(production, /integrationJobs:\s*\{\s*enabled:\s*false/)
    const state = await mkdtemp(join(tmpdir(), 'openfarm-625-'))
    const pg = disposablePostgres({
      name: 'sandbox-625',
      isolated: true,
      through: false,
    })
    const sim = await startMoonrakerMock({
      initial: { state: 'standby', printDuration: 42, totalDuration: 45 },
      maxWsConnections: 8,
    })
    const children: ChildProcess[] = []
    let fileServer: ReturnType<typeof createHttpsServer> | undefined
    let bambu: Awaited<ReturnType<typeof startBambuSimulator>> | undefined
    let logs = ''
    try {
      await mkdir(join(state, 'connector-data'))
      const sql = await pg.start()
      const port = await getFreePort()
      const origin = `https://127.0.0.1:${port}`
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'ec',
          '-pkeyopt',
          'ec_paramgen_curve:P-256',
          '-noenc',
          '-keyout',
          join(state, 'tls.key'),
          '-out',
          join(state, 'tls.crt'),
          '-days',
          '1',
          '-subj',
          '/CN=127.0.0.1',
          '-addext',
          'subjectAltName=IP:127.0.0.1',
        ],
        { stdio: 'ignore' },
      )
      const previousUmask = process.umask(0o022)
      try {
        await seedSandbox(
          sql,
          new URL(`postgres://fixture:fixture@127.0.0.1:${pg.port}/fixture`),
          state,
          { local: true, origin, moonraker: sim.origin },
        )
      } finally {
        process.umask(previousUmask)
      }
      const roles =
        await sql`SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles u ON u.oid = m.member WHERE u.rolname = 'sandbox_jobs' ORDER BY r.rolname`
      assert.deepEqual(
        roles.map((row) => row.rolname),
        [
          'farm_integration_approvals',
          'farm_integration_delivery',
          'farm_integration_jobs',
        ],
      )
      assert.equal(
        (await stat(join(state, 'integration-envelope.json'))).mode & 0o777,
        0o600,
      )
      assert.equal((await stat(join(state, 'app.env'))).mode & 0o777, 0o600)
      assert.equal((await stat(state)).mode & 0o777, 0o700)
      assert.equal(
        (await stat(join(state, 'connector-data'))).mode & 0o777,
        0o700,
      )
      const runtimePath = join(state, 'runtime.json')
      const runtime = JSON.parse(await readFile(runtimePath, 'utf8'))
      assert.equal(runtime.assignments.length, 2)
      assert.ok(
        runtime.assignments.every(
          (assignment: { agent_id: string }) =>
            assignment.agent_id === runtime.assignments[0].agent_id,
        ),
      )
      const { accessCode } = JSON.parse(
        await readFile(join(state, 'bambu-credential.json'), 'utf8'),
      )
      bambu = await startBambuSimulator({
        tls: syntheticBambuTls,
        accessCode,
        initialState: 'IDLE',
      })
      const bambuConfig = runtime.collection.bambu.printers[0]
      bambuConfig.port = bambu.port
      bambuConfig.ftpsPort = bambu.ftpsPort
      bambuConfig.allowedEndpoints = [{ host: '127.0.0.1', port: bambu.port }]
      await writeFile(runtimePath, JSON.stringify(runtime), { mode: 0o600 })
      const env = Object.fromEntries(
        (await readFile(join(state, 'app.env'), 'utf8'))
          .trim()
          .split('\n')
          .map((line) => {
            const at = line.indexOf('=')
            return [line.slice(0, at), line.slice(at + 1)]
          }),
      )
      assert.equal(env.NUXT_INTEGRATION_JOBS_ENABLED, 'true')
      const cert = readFileSync(join(state, 'tls.crt'))
      const key = readFileSync(join(state, 'tls.key'))
      if (!existsSync('infra/sandbox/.output/server/index.mjs'))
        execFileSync('npx', ['nuxt', 'build', 'infra/sandbox'], {
          stdio: 'ignore',
          timeout: 120_000,
        })
      const launch = (args: string[], extra: NodeJS.ProcessEnv) => {
        const child = spawn(process.execPath, args, {
          env: { ...process.env, ...extra },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        children.push(child)
        child.stdout?.on('data', (chunk) => {
          logs = (logs + chunk.toString()).slice(-16000)
        })
        child.stderr?.on('data', (chunk) => {
          logs = (logs + chunk.toString()).slice(-16000)
        })
        return child
      }
      launch(['infra/sandbox/.output/server/index.mjs'], {
        ...env,
        NITRO_HOST: '127.0.0.1',
        NITRO_PORT: String(port),
        NITRO_SSL_CERT: cert.toString(),
        NITRO_SSL_KEY: key.toString(),
      })
      const call = (
        path: string,
        options: {
          method?: string
          headers?: Record<string, string>
          body?: string
        } = {},
      ) =>
        new Promise<{ status: number; body: any }>((resolve, reject) => {
          const req = httpsRequest(
            origin + path,
            { ...options, ca: cert },
            (res) => {
              let text = ''
              res.setEncoding('utf8')
              res.on('data', (c) => {
                text += c
              })
              res.on('end', () => {
                try {
                  resolve({ status: res.statusCode!, body: JSON.parse(text) })
                } catch {
                  resolve({ status: res.statusCode!, body: text })
                }
              })
            },
          )
          req.on('error', reject)
          req.end(options.body)
        })
      const wait = async (
        label: string,
        check: () => Promise<boolean>,
        ms = 30000,
      ) => {
        const end = Date.now() + ms
        while (Date.now() < end) {
          try {
            if (await check()) return
          } catch {}
          await new Promise((r) => setTimeout(r, 200))
        }
        throw Error(`${label} timed out\n${logs}`)
      }
      await wait(
        'farm readiness',
        async () => (await call('/readyz')).status === 200,
      )
      launch(
        [
          'packages/connector/src/cli.ts',
          'run',
          '--config',
          runtimePath,
          '--credential-file',
          join(state, 'credential.json'),
          '--data-dir',
          join(state, 'connector-data'),
        ],
        { NODE_EXTRA_CA_CERTS: join(state, 'tls.crt') },
      )
      const client = JSON.parse(
        await readFile(join(state, 'client.json'), 'utf8'),
      )
      const scopes = [
        'printers:read',
        'files:read',
        'jobs:read',
        'jobs:start',
        'control:basic',
      ]
      const auth = await call('/api/integrations/v1/oauth/token', {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          scope: scopes.join(' '),
        }).toString(),
      })
      assert.equal(auth.status, 200, JSON.stringify(auth.body))
      const headers = { authorization: `Bearer ${auth.body.access_token}` }
      const base = `/api/integrations/v1/printers/${client.printerId}`
      await wait(
        'connector inbox and file list',
        async () => (await call(`${base}/files`, { headers })).status === 200,
      )
      const bytes = Buffer.from('G28\n')
      fileServer = createHttpsServer({ key, cert }, (_req, res) => {
        res.writeHead(200, { 'content-length': bytes.length })
        res.end(bytes)
      })
      fileServer.listen(0, '127.0.0.1')
      await once(fileServer, 'listening')
      const filePort = (fileServer.address() as { port: number }).port
      const submit = await call(`${base}/jobs`, {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
          'idempotency-key': 'sandbox-start',
        },
        body: JSON.stringify({
          fileUrl: `https://127.0.0.1:${filePort}/part.gcode`,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          sizeBytes: bytes.length,
          displayName: 'part.gcode',
        }),
      })
      assert.equal(submit.status, 202, JSON.stringify(submit.body))
      await wait(
        'simulator start',
        async () => sim.control.model().state === 'printing',
      )
      const stop = await call(`${base}/actions`, {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
          'idempotency-key': 'sandbox-stop',
        },
        body: JSON.stringify({ action: 'cancel', args: {} }),
      })
      assert.equal(stop.status, 202, JSON.stringify(stop.body))
      await wait(
        'simulator stop',
        async () => sim.control.model().state === 'cancelled',
      )
      const files = await call(`${base}/files`, { headers })
      assert.equal(files.status, 200)
      assert.ok(files.body.data.some((x: any) => x.name === 'part.gcode'))
      await wait('job history', async () => {
        const result = await call('/api/integrations/v1/jobs', { headers })
        return (
          result.status === 200 &&
          result.body.data.some(
            (x: any) =>
              x.filename === 'part.gcode' && x.printDurationSeconds === 42,
          )
        )
      })
      const bambuBase = `/api/integrations/v1/printers/${runtime.assignments[1].assignment_id}`
      await wait(
        'Bambu file list',
        async () =>
          (await call(`${bambuBase}/files`, { headers })).status === 200,
      )
      const bambuJob = await call(`${bambuBase}/jobs`, {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
          'idempotency-key': 'bambu-start',
        },
        body: JSON.stringify({
          fileUrl: `https://127.0.0.1:${filePort}/part.3mf`,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          sizeBytes: bytes.length,
          displayName: 'part.3mf',
        }),
      })
      assert.equal(bambuJob.status, 202, JSON.stringify(bambuJob.body))
      let bambuStatus: any
      await wait('Bambu start', async () => {
        bambuStatus = (
          await call(`/api/integrations/v1/jobs/${bambuJob.body.id}`, {
            headers,
          })
        ).body
        return (
          bambu!.requests.some((item) => item.command === 'project_file') ||
          ['refused', 'failed', 'outcome-unknown'].includes(bambuStatus.status)
        )
      })
      assert.ok(
        bambu!.requests.some((item) => item.command === 'project_file'),
        JSON.stringify(bambuStatus),
      )
      const bambuStop = await call(`${bambuBase}/actions`, {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
          'idempotency-key': 'bambu-stop',
        },
        body: JSON.stringify({ action: 'cancel', args: {} }),
      })
      assert.equal(bambuStop.status, 202, JSON.stringify(bambuStop.body))
      await wait('Bambu stop', async () =>
        bambu!.requests.some((item) => item.command === 'stop'),
      )
      const bambuFiles = await call(`${bambuBase}/files`, { headers })
      assert.equal(bambuFiles.status, 200)
      assert.ok(
        bambuFiles.body.data.some((item: any) => item.name === 'part.3mf'),
      )
    } finally {
      for (const child of children) child.kill('SIGTERM')
      await Promise.all(
        children.map((child) =>
          child.exitCode === null
            ? once(child, 'exit').catch(() => {})
            : undefined,
        ),
      )
      if (fileServer)
        await new Promise<void>((resolve) => fileServer!.close(() => resolve()))
      await bambu?.close()
      await sim.close()
      await pg.stop()
      await rm(state, { recursive: true, force: true })
    }
  },
)
