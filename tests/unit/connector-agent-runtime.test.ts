import { test, expect } from 'bun:test'
import {
  createHash,
  createPublicKey,
  randomUUID,
  randomBytes,
  verify,
} from 'node:crypto'
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  appendFileSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  chmodSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { loadOrCreateIdentity } from '../../packages/connector/src/identity/store.ts'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { readRuntimeCredential } from '../../packages/connector/src/config/credential.ts'
import { readAgentRuntimeConfig } from '../../packages/connector/src/config/runtime.ts'
import { openScopedTelemetryQueue } from '../../packages/connector/src/runtime/queue-scope.ts'
import {
  telemetryProofPayload,
  TelemetryProofChallenge,
} from '../../packages/farm-protocol/src/telemetry-proof.ts'

function resource(value: object) {
  if (Bun.env.AGENT_TEST_LEDGER)
    appendFileSync(Bun.env.AGENT_TEST_LEDGER, JSON.stringify(value) + '\n')
}
function temporary() {
  const path = mkdtempSync(join(tmpdir(), 'open3d-agent-'))
  resource({ kind: 'directory', id: path, state: 'created' })
  return {
    path,
    close() {
      rmSync(path, { recursive: true })
      resource({ kind: 'directory', id: path, state: 'removed' })
    },
  }
}
function job(args: string[], env = {}) {
  const child = Bun.spawn(['node', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  })
  resource({ kind: 'child', id: child.pid, state: 'created' })
  let output = ''
  const reading = (async () => {
    for await (const bytes of child.stdout)
      output += new TextDecoder().decode(bytes)
  })()
  const error = new Response(child.stderr).text()
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000)
  let recorded = false
  async function finish() {
    const code = await child.exited
    await reading
    clearTimeout(timer)
    if (!recorded) {
      resource({ kind: 'child', id: child.pid, state: 'reaped' })
      recorded = true
    }
    return { code, output, error: await error }
  }
  return {
    get output() {
      return output
    },
    get exited() {
      return child.exitCode !== null
    },
    finish,
    async until(predicate: () => boolean) {
      const deadline = Date.now() + 7000
      while (!predicate()) {
        if (child.exitCode !== null || Date.now() > deadline)
          throw new Error('Agent fixture condition not reached')
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    },
    async stop() {
      if (child.exitCode === null) child.kill('SIGTERM')
      return finish()
    },
    async close() {
      if (child.exitCode === null) child.kill('SIGKILL')
      await finish()
    },
  }
}
const lines = (output: string, kind: string) =>
  output.split('\n').filter((line) => line.includes(`"kind":"${kind}"`)).length
function delivered(output: string): number {
  return output
    .split('\n')
    .slice(0, -1)
    .reduce((count, line) => {
      const value = JSON.parse(line)
      return (
        count +
        (value.kind === 'delivery' && value.status === 'delivered'
          ? value.count
          : 0)
      )
    }, 0)
}

async function fixture() {
  const temp = temporary()
  const data = join(temp.path, 'data')
  const identity = loadOrCreateIdentity(data)
  const farm = randomUUID(),
    agent = randomUUID(),
    assignment = randomUUID()
  const token = 'aaa.bbb.ccc',
    audience = 'agent-fixture'
  const cert = join(temp.path, 'cert.pem'),
    key = join(temp.path, 'key.pem')
  const openssl = Bun.spawn(
    [
      'openssl',
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { stdout: 'ignore', stderr: 'pipe' },
  )
  resource({ kind: 'child', id: openssl.pid, state: 'created' })
  const certTimer = setTimeout(() => openssl.kill('SIGKILL'), 5000)
  const certExit = await openssl.exited
  const certError = await new Response(openssl.stderr).text()
  clearTimeout(certTimer)
  resource({ kind: 'child', id: openssl.pid, state: 'reaped' })
  if (certExit !== 0) {
    temp.close()
    throw new Error(certError)
  }
  const sockets = new Set<ServerWebSocket<undefined>>()
  let moonRequests = 0
  const moon = Bun.serve<undefined>({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, server) {
      moonRequests++
      if (new URL(request.url).pathname === '/websocket') {
        if (server.upgrade(request, { data: undefined })) return
        return new Response(null, { status: 400 })
      }
      return Response.json({
        result: { klippy_connected: true, klippy_state: 'ready' },
      })
    },
    websocket: {
      open(socket) {
        sockets.add(socket)
      },
      close(socket) {
        sockets.delete(socket)
      },
      message(socket) {
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              eventtime: 10,
              status: {
                webhooks: { state: 'ready' },
                print_stats: { state: 'printing' },
                virtual_sdcard: { progress: 0.25 },
              },
            },
          }),
        )
      },
    },
  })
  resource({ kind: 'loopback', id: moon.port, state: 'created' })
  let accepting = false,
    cloudRequests = 0
  const issued: Array<{ body: string; jti: string; at: number }> = []
  const completed: Array<{ body: string; jti: string; signature: string }> = []
  const accepted = new Map<string, string>()
  const proofs = new Map<
    string,
    ReturnType<typeof TelemetryProofChallenge.parse>
  >()
  const failures: string[] = []
  let holding = false
  const releases = new Set<() => void>()
  const cloud = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    tls: { cert: readFileSync(cert), key: readFileSync(key) },
    async fetch(request) {
      cloudRequests++
      try {
        const body = await request.text()
        if (request.headers.get('authorization') !== 'Bearer ' + token)
          throw new Error('Fixture token mismatch')
        if (new URL(request.url).pathname.endsWith('/challenge')) {
          const now = Date.now(),
            jti = randomUUID()
          const challenge = TelemetryProofChallenge.parse({
            v: 2,
            purpose: 'telemetry-ingestion',
            method: 'POST',
            path: '/api/connector/telemetry',
            agent_id: agent,
            farm_id: farm,
            jti,
            connection_id: randomUUID(),
            public_key_spki: identity.publicKeySpki,
            fingerprint: identity.fingerprint,
            thumbprint: createHash('sha256')
              .update('fixture')
              .digest('base64url'),
            token_hash: createHash('sha256').update(token).digest('base64url'),
            origin: new URL(request.url).origin,
            audience,
            generation: 1,
            nonce: randomBytes(32).toString('base64url'),
            issued_at: now,
            expires_at: now + 5000,
            body_sha256: createHash('sha256').update(body).digest('base64url'),
            body_bytes: Buffer.byteLength(body),
          })
          proofs.set(jti, challenge)
          issued.push({ body, jti, at: performance.now() })
          return Response.json({ challenge })
        }
        const encoded = request.headers.get('x-telemetry-challenge') ?? ''
        const challenge = TelemetryProofChallenge.parse(
          JSON.parse(Buffer.from(encoded, 'base64url').toString()),
        )
        const signature = request.headers.get('x-telemetry-signature') ?? ''
        if (
          !proofs.has(challenge.jti) ||
          challenge.body_sha256 !==
            createHash('sha256').update(body).digest('base64url') ||
          !verify(
            null,
            telemetryProofPayload(challenge),
            createPublicKey({
              key: Buffer.from(identity.publicKeySpki, 'base64url'),
              format: 'der',
              type: 'spki',
            }),
            Buffer.from(signature, 'base64url'),
          )
        )
          throw new Error('Fixture proof invalid')
        proofs.delete(challenge.jti)
        completed.push({ body, jti: challenge.jti, signature })
        const records: Array<{ eventId: string }> = JSON.parse(body)
        for (const record of records)
          accepted.set(record.eventId, JSON.stringify(record))
        if (holding)
          await new Promise<void>((resolve) => {
            releases.add(resolve)
          })
        if (!accepting)
          return Response.json({ error: 'synthetic-lost-ack' }, { status: 503 })
        return Response.json({
          ok: true,
          acceptedEventIds: records.map((record) => record.eventId),
        })
      } catch (error) {
        failures.push(error instanceof Error ? error.message : 'error')
        return Response.json({ error: 'fixture-error' }, { status: 400 })
      }
    },
  })
  resource({ kind: 'loopback', id: cloud.port, state: 'created' })
  const moonOrigin = `http://127.0.0.1:${moon.port}`
  const configPath = join(temp.path, 'runtime.json'),
    credentialPath = join(temp.path, 'credential.json')
  const configuration = {
    version: 1,
    collection: {
      version: 1,
      allowedOrigins: [moonOrigin],
      printers: [{ printerKey: 'A/\u{1f600}/a', origin: moonOrigin }],
      limits: {
        connectTimeoutMs: 1500,
        requestTimeoutMs: 1500,
        staleAfterMs: 5000,
      },
    },
    assignments: [
      {
        assignment_id: assignment,
        farm_id: farm,
        agent_id: agent,
        printer_key: 'A/\u{1f600}/a',
        moonraker_origin: moonOrigin,
      },
    ],
    telemetry: {
      endpoint: `https://127.0.0.1:${cloud.port}/api/connector/telemetry`,
      audience,
      timeoutMs: 1000,
      retryMinMs: 300,
      retryMaxMs: 300,
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
      device_token: token,
      expires_at: Date.now() + 60000,
    },
  }
  function save() {
    writeFileSync(configPath, JSON.stringify(configuration), { mode: 0o600 })
    writeFileSync(credentialPath, JSON.stringify(credential), { mode: 0o600 })
  }
  save()
  return {
    data,
    temp,
    configuration,
    credential,
    configPath,
    credentialPath,
    issued,
    completed,
    accepted,
    failures,
    save,
    sockets,
    get moonRequests() {
      return moonRequests
    },
    get cloudRequests() {
      return cloudRequests
    },
    accept() {
      accepting = true
    },
    hold() {
      holding = true
    },
    release() {
      holding = false
      for (const resolve of releases) resolve()
      releases.clear()
    },
    launch(extraEnv = {}) {
      return job(
        [
          'packages/connector/src/cli.ts',
          'run',
          '--config',
          configPath,
          '--credential-file',
          credentialPath,
          '--data-dir',
          data,
        ],
        {
          NODE_EXTRA_CA_CERTS: cert,
          WS_NO_BUFFER_UTIL: '',
          WS_NO_UTF_8_VALIDATE: '',
          ...extraEnv,
        },
      )
    },
    delta() {
      for (const socket of sockets)
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            method: 'notify_status_update',
            params: [{ virtual_sdcard: { progress: 0.75 } }, 11],
          }),
        )
    },
    async close() {
      for (const resolve of releases) resolve()
      for (const socket of sockets) socket.terminate()
      const moonPort = moon.port,
        cloudPort = cloud.port
      await moon.stop(true)
      await cloud.stop(true)
      resource({ kind: 'loopback', id: moonPort, state: 'closed' })
      resource({ kind: 'loopback', id: cloudPort, state: 'closed' })
      temp.close()
    },
  }
}

function seedScoped(server: Awaited<ReturnType<typeof fixture>>, now: number) {
  const identity = loadOrCreateIdentity(server.data)
  const credential = readRuntimeCredential(
    server.credentialPath,
    identity.fingerprint,
    Date.now(),
  )
  const config = readAgentRuntimeConfig(server.configPath, credential)
  return openScopedTelemetryQueue({
    dataDirectory: server.data,
    config,
    credential,
    now,
  })
}

test('standalone collection rechecks scope under lock before recovery', async () => {
  const server = await fixture()
  const collection = join(server.temp.path, 'collection.json')
  writeFileSync(collection, JSON.stringify(server.configuration.collection), {
    mode: 0o600,
  })
  const running = job(
    [
      '--import',
      './tests/helpers/connector-queue-race-loader.mjs',
      'packages/connector/src/cli.ts',
      'collect',
      '--config',
      collection,
      '--data-dir',
      server.data,
    ],
    { QUEUE_RACE_DIR: server.temp.path },
  )
  try {
    await running.until(() => existsSync(join(server.temp.path, 'paused')))
    const old = Date.now() - 25 * 60 * 60 * 1000
    const queue = seedScoped(server, old)
    queue.enqueue(
      { printerKey: 'A/😀/a', state: 'idle', progress: 0, observedAt: old },
      old,
    )
    queue.close()
    const dir = join(server.data, 'telemetry')
    const log = join(dir, 'telemetry.jsonl')
    const receipt = join(dir, 'scope.json')
    const compact = join(dir, 'telemetry.compact')
    writeFileSync(compact, 'candidate', { mode: 0o600 })
    const before = [
      readFileSync(log),
      readFileSync(receipt),
      readFileSync(compact),
    ]
    writeFileSync(join(server.temp.path, 'resume'), 'go')
    const deadline = Date.now() + 7000
    while (
      Date.now() < deadline &&
      !running.exited &&
      lines(running.output, 'queued') === 0
    )
      await new Promise((resolve) => setTimeout(resolve, 10))
    const result = running.exited
      ? await running.finish()
      : await running.stop()
    expect(
      result.code,
      JSON.stringify({
        moonRequests: server.moonRequests,
        queued: lines(result.output, 'queued'),
        logChanged: !readFileSync(log).equals(before[0]!),
        compactExists: existsSync(compact),
      }),
    ).toBe(1)
    expect([
      readFileSync(log),
      readFileSync(receipt),
      readFileSync(compact),
    ]).toEqual(before)
    expect(server.moonRequests).toBe(0)
    expect(server.sockets.size).toBe(0)
    expect(existsSync(join(dir, 'telemetry.lock'))).toBe(false)
  } finally {
    await running.close()
    await server.close()
  }
}, 20000)

test('uncertain acknowledgement retains drain expiry in the agent summary', async () => {
  const server = await fixture()
  server.accept()
  server.hold()
  server.credential.approval.expires_at = Date.now() + 600000
  server.save()
  const now = Date.now()
  const old = now - 24 * 60 * 60 * 1000 + 60000
  const queue = seedScoped(server, old)
  queue.enqueue(
    { printerKey: 'A/😀/a', state: 'idle', progress: 0, observedAt: old },
    old,
  )
  queue.enqueue(
    { printerKey: 'A/😀/a', state: 'idle', progress: 0, observedAt: now },
    now,
  )
  queue.close()
  const running = server.launch({
    NODE_OPTIONS: '--import ./tests/helpers/connector-queue-race-loader.mjs',
    QUEUE_ADVANCE_DRAIN: '1',
  })
  try {
    await running.until(() => server.completed.length >= 1)
    expect(JSON.parse(server.completed[0]!.body)).toHaveLength(1)
    const log = join(server.data, 'telemetry', 'telemetry.jsonl')
    renameSync(log, log + '.saved')
    mkdirSync(log, { mode: 0o700 })
    server.release()
    const result = await running.finish()
    expect(result.code).toBe(1)
    const summary = result.output
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((value) => value.kind === 'agent-summary')
    expect(summary.expired).toBe(1)
    expect(summary.delivered).toBe(0)
    expect(server.sockets.size).toBe(0)
  } finally {
    await running.close()
    await server.close()
  }
}, 20000)

test('actual run CLI retries fresh proofs with durable IDs and resumes the scoped queue after restart', async () => {
  const server = await fixture()
  const first = server.launch()
  try {
    await first.until(() => server.completed.length >= 2)
    expect(server.issued[0]!.body).toBe(server.issued[1]!.body)
    expect(server.completed[0]!.jti).not.toBe(server.completed[1]!.jti)
    expect(server.completed[0]!.signature).not.toBe(
      server.completed[1]!.signature,
    )
    expect(server.issued[1]!.at - server.issued[0]!.at).toBeGreaterThanOrEqual(
      280,
    )
    expect(server.accepted.size).toBe(1)
    expect((await first.stop()).code).toBe(0)
    expect(server.sockets.size).toBe(0)
    const queue = new TelemetryQueue(join(server.data, 'telemetry'), Date.now())
    let retainedId: string
    try {
      expect(queue.depth).toBe(1)
      retainedId = queue.batch(Date.now()).records[0]!.eventId
    } finally {
      queue.close()
    }
    server.accept()
    const resumed = server.launch()
    try {
      await resumed.until(
        () =>
          lines(resumed.output, 'queued') >= 1 &&
          delivered(resumed.output) >= 2 &&
          server.completed
            .slice(2)
            .some((row) => row.body.includes(retainedId)),
      )
      const result = await resumed.stop()
      expect(result.code).toBe(0)
      expect(result.error).toBe('')
      const recovered = new TelemetryQueue(
        join(server.data, 'telemetry'),
        Date.now(),
      )
      try {
        expect(recovered.depth).toBe(0)
      } finally {
        recovered.close()
      }
      expect(result.output).not.toContain(
        server.credential.approval.device_token,
      )
      expect(result.output).not.toContain(
        server.configuration.collection.printers[0]!.printerKey,
      )
      expect(result.output).not.toContain(server.temp.path)
      expect(server.failures).toEqual([])
    } finally {
      await resumed.close()
    }
  } finally {
    await first.close()
    await server.close()
  }
}, 20000)

test('wrong scope and standalone collect on scoped storage make zero network calls', async () => {
  const server = await fixture()
  const first = server.launch()
  try {
    await first.until(() => server.completed.length >= 1)
    await first.stop()
    const requests = [server.cloudRequests, server.moonRequests]
    const log = join(server.data, 'telemetry', 'telemetry.jsonl'),
      before = readFileSync(log)
    server.configuration.assignments[0]!.assignment_id = randomUUID()
    server.save()
    const wrong = server.launch()
    try {
      expect((await wrong.finish()).code).toBe(1)
    } finally {
      await wrong.close()
    }
    const collection = join(server.temp.path, 'collection.json')
    writeFileSync(collection, JSON.stringify(server.configuration.collection), {
      mode: 0o600,
    })
    const standalone = job([
      'packages/connector/src/cli.ts',
      'collect',
      '--config',
      collection,
      '--data-dir',
      server.data,
    ])
    try {
      expect((await standalone.finish()).code).toBe(1)
    } finally {
      await standalone.close()
    }
    expect([server.cloudRequests, server.moonRequests]).toEqual(requests)
    expect(readFileSync(log)).toEqual(before)
  } finally {
    await first.close()
    await server.close()
  }
}, 20000)

test('uncertain durable acknowledgement aborts and joins all collection without false delivery', async () => {
  const server = await fixture()
  server.accept()
  server.hold()
  const running = server.launch()
  try {
    await running.until(() => server.completed.length >= 1)
    const log = join(server.data, 'telemetry', 'telemetry.jsonl')
    renameSync(log, log + '.saved')
    mkdirSync(log, { mode: 0o700 })
    server.release()
    const result = await running.finish()
    expect(result.code).toBe(1)
    expect(result.output).not.toContain('"status":"delivered"')
    expect(server.sockets.size).toBe(0)
    expect(existsSync(join(server.data, 'telemetry', 'telemetry.lock'))).toBe(
      false,
    )
    expect(result.error).not.toContain(server.temp.path)
    expect(result.error).not.toContain(server.credential.approval.device_token)
  } finally {
    await running.close()
    await server.close()
  }
}, 20000)

test('receiptless initialized queues reject before retention can discard old unbound data', async () => {
  for (const mode of ['empty', 'expired', 'interrupted']) {
    const server = await fixture()
    try {
      const directory = join(server.data, 'telemetry'),
        log = join(directory, 'telemetry.jsonl')
      if (mode === 'interrupted') mkdirSync(directory, { mode: 0o700 })
      else {
        const old = Date.now() - 25 * 60 * 60 * 1000
        const queue = new TelemetryQueue(directory, old)
        if (mode === 'expired')
          queue.enqueue(
            {
              printerKey: 'unbound',
              state: 'idle',
              progress: 0,
              observedAt: old,
            },
            old,
          )
        queue.close()
      }
      const before = existsSync(log) ? readFileSync(log) : undefined
      const running = server.launch()
      try {
        expect((await running.finish()).code).toBe(1)
      } finally {
        await running.close()
      }
      expect(server.cloudRequests).toBe(0)
      expect(server.moonRequests).toBe(0)
      expect(existsSync(join(directory, 'scope.json'))).toBe(false)
      if (before) expect(readFileSync(log)).toEqual(before)
    } finally {
      await server.close()
    }
  }
}, 20000)

test('local credential expiry stops authentication attempts while bounded local collection continues', async () => {
  const server = await fixture()
  server.credential.approval.expires_at = Date.now() + 1500
  server.accept()
  server.save()
  const running = server.launch()
  try {
    await running.until(() =>
      running.output.includes('"kind":"credential-expired"'),
    )
    const count = server.cloudRequests
    server.delta()
    await running.until(() => lines(running.output, 'queued') >= 2)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(server.cloudRequests).toBe(count)
    expect((await running.stop()).code).toBe(0)
    const queue = new TelemetryQueue(join(server.data, 'telemetry'), Date.now())
    try {
      expect(queue.depth).toBe(1)
    } finally {
      queue.close()
    }
  } finally {
    await running.close()
    await server.close()
  }
}, 20000)

test('expired or mismatched credentials fail before any queue or network', async () => {
  for (const mode of [
    'expiry',
    'fingerprint',
    'mapping',
    'oversized',
    'public',
    'duplicate',
    'fifo',
    'missing-identity',
    'audience',
  ]) {
    const server = await fixture()
    try {
      if (mode === 'expiry')
        server.credential.approval.expires_at = Date.now() - 1
      if (mode === 'fingerprint')
        server.credential.expected_fingerprint = 'SHA256:' + 'A'.repeat(43)
      if (mode === 'mapping')
        server.configuration.assignments[0]!.farm_id = randomUUID()
      if (mode === 'audience')
        server.configuration.telemetry.audience = 'invalid audience'
      server.save()
      if (mode === 'oversized')
        writeFileSync(server.credentialPath, ' '.repeat(16 * 1024 + 1))
      if (mode === 'public') chmodSync(server.credentialPath, 0o644)
      if (mode === 'duplicate')
        writeFileSync(
          server.credentialPath,
          readFileSync(server.credentialPath, 'utf8').replace(
            '{"version":1,',
            '{"version":1,"version":1,',
          ),
        )
      if (mode === 'missing-identity')
        unlinkSync(join(server.data, 'identity.json'))
      if (mode === 'fifo') {
        unlinkSync(server.credentialPath)
        const make = Bun.spawn(['mkfifo', '-m', '600', server.credentialPath], {
          stdout: 'ignore',
          stderr: 'pipe',
        })
        resource({ kind: 'child', id: make.pid, state: 'created' })
        const timer = setTimeout(() => make.kill('SIGKILL'), 2000)
        const code = await make.exited
        clearTimeout(timer)
        await new Response(make.stderr).text()
        resource({ kind: 'child', id: make.pid, state: 'reaped' })
        expect(code).toBe(0)
      }
      const running = server.launch()
      try {
        expect((await running.finish()).code).toBe(1)
      } finally {
        await running.close()
      }
      expect(existsSync(join(server.data, 'telemetry'))).toBe(false)
      expect(server.cloudRequests).toBe(0)
      expect(server.moonRequests).toBe(0)
      if (mode === 'missing-identity')
        expect(existsSync(join(server.data, 'identity.json'))).toBe(false)
    } finally {
      await server.close()
    }
  }
}, 20000)

test('malformed, missing and interrupted scope receipts stay untouched and cannot reach any network', async () => {
  const server = await fixture()
  const first = server.launch()
  try {
    await first.until(() => server.completed.length >= 1)
    await first.stop()
    const directory = join(server.data, 'telemetry'),
      receipt = join(directory, 'scope.json'),
      marker = join(directory, 'scope.pending')
    const original = readFileSync(receipt),
      before = readFileSync(join(directory, 'telemetry.jsonl'))
    const requests = [server.cloudRequests, server.moonRequests]
    for (const mode of ['malformed', 'missing', 'pending']) {
      writeFileSync(receipt, original, { mode: 0o600 })
      if (mode === 'malformed') writeFileSync(receipt, '{')
      else unlinkSync(receipt)
      if (mode === 'pending')
        writeFileSync(marker, 'interrupted', { mode: 0o600 })
      const running = server.launch()
      try {
        expect((await running.finish()).code).toBe(1)
      } finally {
        await running.close()
      }
      expect([server.cloudRequests, server.moonRequests]).toEqual(requests)
      expect(readFileSync(join(directory, 'telemetry.jsonl'))).toEqual(before)
      if (mode === 'malformed') expect(readFileSync(receipt, 'utf8')).toBe('{')
      else expect(existsSync(receipt)).toBe(false)
      if (mode === 'pending') {
        const local = join(server.temp.path, 'local.json')
        writeFileSync(local, JSON.stringify(server.configuration.collection), {
          mode: 0o600,
        })
        const standalone = job([
          'packages/connector/src/cli.ts',
          'collect',
          '--config',
          local,
          '--data-dir',
          server.data,
        ])
        try {
          expect((await standalone.finish()).code).toBe(1)
        } finally {
          await standalone.close()
        }
        expect(readFileSync(marker, 'utf8')).toBe('interrupted')
        expect([server.cloudRequests, server.moonRequests]).toEqual(requests)
      }
    }
  } finally {
    await first.close()
    await server.close()
  }
}, 20000)

test('pure runtime config import cannot load ws or networking modules', async () => {
  const process = job([
    '--import',
    './tests/helpers/connector-agent-import-policy.ts',
    '-e',
    "import('./packages/connector/src/config/runtime.ts').then(()=>console.log('pure'))",
  ])
  try {
    const result = await process.finish()
    expect(result.code).toBe(0)
    expect(result.error).toBe('')
    expect(result.output).toBe('pure\n')
  } finally {
    await process.close()
  }
}, 10000)

test('new observations cannot bypass a pending outer retry deadline', async () => {
  const server = await fixture()
  const running = server.launch()
  try {
    await running.until(() => lines(running.output, 'delivery') >= 1)
    server.delta()
    await running.until(() => lines(running.output, 'queued') >= 2)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(server.issued.length).toBe(1)
    await running.until(() => server.completed.length >= 2)
    expect(server.issued[1]!.at - server.issued[0]!.at).toBeGreaterThanOrEqual(
      280,
    )
    const firstIds = JSON.parse(server.issued[0]!.body).map(
      (record: { eventId: string }) => record.eventId,
    )
    const nextIds = JSON.parse(server.issued[1]!.body).map(
      (record: { eventId: string }) => record.eventId,
    )
    expect(nextIds[0]).toBe(firstIds[0])
    expect(nextIds.length).toBe(2)
    expect((await running.stop()).code).toBe(0)
  } finally {
    await running.close()
    await server.close()
  }
}, 20000)

test('SIGTERM during an authenticated request joins shutdown and never acknowledges the held response', async () => {
  const server = await fixture()
  server.accept()
  server.hold()
  const running = server.launch()
  try {
    await running.until(() => server.completed.length >= 1)
    const result = await running.stop()
    expect(result.code).toBe(0)
    expect(result.output).not.toContain('"status":"delivered"')
    expect(server.sockets.size).toBe(0)
    server.release()
    const queue = new TelemetryQueue(join(server.data, 'telemetry'), Date.now())
    try {
      expect(queue.depth).toBe(1)
    } finally {
      queue.close()
    }
    expect(server.issued.length).toBe(1)
  } finally {
    await running.close()
    await server.close()
  }
}, 20000)
