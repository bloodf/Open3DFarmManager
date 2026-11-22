import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, request as httpRequest } from 'node:http'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadOrCreateIdentity } from '../../packages/connector/src/identity/store.ts'
import { readRuntimeCredential } from '../../packages/connector/src/config/credential.ts'
import { readAgentRuntimeConfig } from '../../packages/connector/src/config/runtime.ts'
import { openScopedTelemetryQueue } from '../../packages/connector/src/runtime/queue-scope.ts'

const cli = fileURLToPath(
  new URL('../../packages/connector/src/cli.ts', import.meta.url),
)

function bind(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    res.writeHead(404).end()
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Fixture did not bind a TCP port'))
        return
      }
      resolve({
        port: address.port,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()))
          }),
      })
    })
  })
}

function freePort(): Promise<number> {
  const server = createServer()
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Fixture did not bind a TCP port'))
        return
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)))
    })
  })
}

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
  ])
    delete env[key]
  env.NO_PROXY = '127.0.0.1'
  env.no_proxy = '127.0.0.1'
  return env
}

function launch(args: string[]) {
  const child = spawn(process.execPath, [cli, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv(),
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk
  })
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolve(code))
  })
  return {
    child,
    closed,
    text: () => ({ stdout, stderr }),
  }
}

function status(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: '/status',
        method: 'GET',
        headers: { host: `127.0.0.1:${port}` },
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

async function untilStatus(
  port: number,
  child: ChildProcess,
  text: () => { stdout: string; stderr: string },
) {
  const deadline = Date.now() + 20_000
  let last = 'unreachable'
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      const output = text()
      throw new Error(
        `run exited ${child.exitCode} before status. stderr=${output.stderr.slice(-500)} stdout=${output.stdout.slice(-500)}`,
      )
    }
    try {
      const code = await status(port)
      if (code === 200) return
      last = String(code)
    } catch (error) {
      last = error instanceof Error ? error.message : 'error'
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`status port stayed ${last}`)
}

async function stop(
  child: ChildProcess,
  closed: Promise<number | null>,
  text: () => { stdout: string; stderr: string },
) {
  if (child.exitCode === null) child.kill('SIGTERM')
  let timer: ReturnType<typeof setTimeout> | undefined
  let code: number | null
  try {
    code = await Promise.race([
      closed,
      new Promise<number | null>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`SIGTERM did not exit. ${text().stderr.slice(-500)}`),
            ),
          20_000,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
  return { code, ...text() }
}

test('SIGTERM closes the run command and a second run reuses the data directory', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'open3d-sigterm-'))
  const data = join(root, 'data')
  const configPath = join(root, 'runtime.json')
  const credentialPath = join(root, 'credential.json')
  const queueDir = join(data, 'telemetry')
  const queueFile = join(queueDir, 'telemetry.jsonl')
  const ackFile = join(queueDir, 'telemetry.ack')
  const lockFile = join(queueDir, 'telemetry.lock')
  const journal = join(data, 'runtime.jsonl')
  const moon = await bind()
  const cloud = await bind()
  let running: ReturnType<typeof launch> | undefined
  t.after(async () => {
    if (running && running.child.exitCode === null)
      running.child.kill('SIGKILL')
    await moon.close()
    await cloud.close()
    rmSync(root, { recursive: true, force: true })
  })

  const identity = loadOrCreateIdentity(data)
  const farm = randomUUID()
  const agent = randomUUID()
  const origin = `http://127.0.0.1:${moon.port}`
  const configuration = {
    version: 1,
    collection: {
      version: 1,
      allowedOrigins: [origin],
      printers: [{ printerKey: 'fixture-printer', origin }],
      limits: {
        connectTimeoutMs: 200,
        requestTimeoutMs: 200,
        staleAfterMs: 1000,
        reconnectMinMs: 200,
        reconnectMaxMs: 200,
      },
    },
    assignments: [
      {
        assignment_id: randomUUID(),
        farm_id: farm,
        agent_id: agent,
        printer_key: 'fixture-printer',
        moonraker_origin: origin,
      },
    ],
    telemetry: {
      endpoint: `https://127.0.0.1:${cloud.port}/api/connector/telemetry`,
      audience: 'agent-fixture',
      timeoutMs: 200,
      retryMinMs: 200,
      retryMaxMs: 200,
      idleMs: 100,
    },
  }
  const credential = {
    version: 1,
    expected_fingerprint: identity.fingerprint,
    approval: {
      status: 'approved',
      agent_id: agent,
      farm_id: farm,
      device_token: 'aaa.bbb.ccc',
      expires_at: Date.now() + 600_000,
    },
  }
  writeFileSync(configPath, JSON.stringify(configuration), { mode: 0o600 })
  writeFileSync(credentialPath, JSON.stringify(credential), { mode: 0o600 })
  const now = Date.now()
  const seeded = openScopedTelemetryQueue({
    dataDirectory: data,
    config: readAgentRuntimeConfig(
      configPath,
      readRuntimeCredential(credentialPath, identity.fingerprint, now),
    ),
    credential: readRuntimeCredential(
      credentialPath,
      identity.fingerprint,
      now,
    ),
    now,
  })
  const queued = seeded.enqueue(
    {
      printerKey: 'fixture-printer',
      state: 'idle',
      progress: 0,
      observedAt: now,
    },
    now,
  )
  seeded.acknowledge([queued.eventId], now)
  seeded.close()
  assert.equal(existsSync(lockFile), false)
  assert.equal(existsSync(ackFile), true)

  const statusPort = await freePort()
  const args = [
    'run',
    '--config',
    configPath,
    '--credential-file',
    credentialPath,
    '--data-dir',
    data,
    '--status-port',
    String(statusPort),
  ]

  async function cycle() {
    running = launch(args)
    await untilStatus(statusPort, running.child, running.text)
    assert.equal(existsSync(lockFile), true)
    const queueBytes = readFileSync(queueFile)
    const ackBytes = readFileSync(ackFile)
    const stopped = await stop(running.child, running.closed, running.text)
    running = undefined
    assert.equal(stopped.code, 0, stopped.stderr.slice(-500))
    assert.deepEqual(readFileSync(queueFile), queueBytes)
    assert.deepEqual(readFileSync(ackFile), ackBytes)
    assert.equal(existsSync(lockFile), false)
    assert.equal(existsSync(join(queueDir, 'telemetry.ack.tmp')), false)
    const lines = readFileSync(journal, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { msg?: string })
    assert.equal(lines.at(-1)?.msg, 'stop')
    assert.equal(
      stopped.stdout.includes('"kind":"queue-lock-recovered"'),
      false,
    )
    await new Promise<void>((resolve, reject) => {
      const probe = createServer()
      probe.once('error', reject)
      probe.listen(statusPort, '127.0.0.1', () => {
        probe.close(() => resolve())
      })
    })
    return stopped
  }

  const first = await cycle()
  assert.equal(first.stdout.includes('"kind":"agent-summary"'), true)
  const second = await cycle()
  assert.equal(second.stdout.includes('"kind":"agent-summary"'), true)
})
