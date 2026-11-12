// Outage and restart acceptance for the Connector against the built farm server.
// Caller owns the disposable PostgreSQL container, work directory and port range.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Sql } from 'postgres'
import { ENROLLMENT, enrollConnector } from './connector-enrollment.ts'
import { loadOrCreateIdentity } from '../../packages/connector/src/identity/store.ts'
import {
  handlerErrors,
  startConnector,
  startFakeMoonraker,
  startFarmApp,
  startFaultProxy,
  until,
} from './connector-outage-fixtures.ts'

const QUEUE_MAX_BYTES = 50 * 1024 * 1024 // Documented TelemetryQueue cap.
const TELEMETRY = { timeoutMs: 3000, retryMinMs: 500, retryMaxMs: 2000 }
// Upper bound for the gap between two attempts: deadline + max backoff + load slack.
const MAX_ATTEMPT_GAP_MS = TELEMETRY.timeoutMs + TELEMETRY.retryMaxMs + 2500

type Ports = { db: number; app: number; proxy: number; moonraker: number }
type Record = { eventId: string; queuedAt: number; kind: string } & {
  state?: { progress: number; state: string }
}

export async function runConnectorOutageScenarios(input: {
  admin: Sql
  ports: Ports
  workDir: string
  container: string
  docker: (...args: string[]) => Promise<string>
  ledger: (value: object) => void
}) {
  const { admin, ports, workDir, ledger } = input
  const prefix = 'outage_' + randomUUID().replaceAll('-', '')
  const roles = [
    { name: prefix, group: 'farm_connector_telemetry_writer' },
    { name: prefix + '_pair', group: 'farm_pairing_runtime' },
    { name: prefix + '_owner', group: 'farm_printer_ownership' },
  ]
  const created: string[] = []
  const pools: Sql[] = []
  const closers: Array<() => Promise<void>> = []
  const report: { scenarios: object[]; findings: string[] } = {
    scenarios: [],
    findings: [],
  }
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
    const pairSql = connect(prefix + '_pair'),
      ownerSql = connect(prefix + '_owner')

    // TLS and Connector identity, all inside the private work directory.
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
    const queueFile = join(dataDir, 'telemetry', 'telemetry.jsonl')
    const lockFile = join(dataDir, 'telemetry', 'telemetry.lock')

    const proxy = await startFaultProxy({
      port: ports.proxy,
      appPort: ports.app,
      cert: readFileSync(cert),
      key: readFileSync(tlsKey),
    })
    closers.push(async () => {
      writeFileSync(join(workDir, 'proxy-log.json'), JSON.stringify(proxy.log))
      await proxy.close()
    })
    ledger({ resource: 'loopback-proxy', port: ports.proxy })
    const moon = await startFakeMoonraker(ports.moonraker)
    closers.push(() => moon.close())
    ledger({ resource: 'loopback-moonraker', port: ports.moonraker })

    // Real enrollment: pairing, proof, approval, credential claim and printer assignment.
    const { issuer, audience, ttlSeconds } = ENROLLMENT
    const printerKey = 'outage-printer'
    const enrolled = await enrollConnector({
      admin,
      pairSql,
      ownerSql,
      identity,
      origin: proxy.origin,
      workDir,
      printerKeys: [printerKey],
    })
    const { keyFile, farmId, agentId, approval } = enrolled
    const registered = enrolled.assignments[0]!

    const configPath = join(workDir, 'runtime.json'),
      credentialPath = join(workDir, 'credential.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        collection: {
          version: 1,
          allowedOrigins: [moon.origin],
          printers: [{ printerKey, origin: moon.origin }],
          // Long stale window: an idle fixture must not force resubscription records.
          limits: { staleAfterMs: 300000, connectTimeoutMs: 2000 },
        },
        assignments: [
          {
            assignment_id: registered.assignmentId,
            farm_id: farmId,
            agent_id: agentId,
            printer_key: printerKey,
            moonraker_origin: moon.origin,
          },
        ],
        telemetry: {
          endpoint: proxy.origin + '/api/connector/telemetry',
          audience,
          idleMs: 200,
          ...TELEMETRY,
        },
      }),
      { mode: 0o600, flag: 'wx' },
    )
    writeFileSync(
      credentialPath,
      JSON.stringify({
        version: 1,
        expected_fingerprint: identity.fingerprint,
        approval,
      }),
      { mode: 0o600, flag: 'wx' },
    )

    // Process control.
    const databaseUrl = (user: string) =>
      `postgres://${encodeURIComponent(user)}:synthetic@127.0.0.1:${ports.db}/fixture`
    const appEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      NODE_ENV: 'production',
      NITRO_HOST: '127.0.0.1',
      NITRO_PORT: String(ports.app),
      NUXT_DATABASE_ENABLED: 'true',
      NUXT_DATABASE_DATABASE_URL: databaseUrl('fixture'),
      NUXT_DATABASE_MIGRATIONS: 'verify',
      NUXT_DATABASE_MIGRATIONS_DIR: fileURLToPath(
        new URL('../../infra/db/migrations/', import.meta.url),
      ),
      NUXT_CONNECTOR_TELEMETRY_ENABLED: 'true',
      NUXT_CONNECTOR_TELEMETRY_DATABASE_URL: databaseUrl(prefix),
      NUXT_CONNECTOR_TELEMETRY_ORIGIN: proxy.origin,
      NUXT_CONNECTOR_TELEMETRY_ISSUER: issuer,
      NUXT_CONNECTOR_TELEMETRY_AUDIENCE: audience,
      NUXT_CONNECTOR_TELEMETRY_PUBLIC_KEY_REGISTRY_PATH: keyFile,
      NUXT_CONNECTOR_TELEMETRY_TOKEN_TTL_SECONDS: String(ttlSeconds),
      NUXT_CONNECTOR_TELEMETRY_PROOF_TTL_MS: '30000',
      NUXT_CONNECTOR_TELEMETRY_BODY_TIMEOUT_MS: '5000',
    }
    let app: ReturnType<typeof startFarmApp> | undefined
    const appLog = join(workDir, 'app.log')
    const launchApp = () => {
      app = startFarmApp({
        env: appEnv,
        logPath: appLog,
        onPid: (pid) => ledger({ resource: 'app-process', pid }),
      })
      return app
    }
    const ready = async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${ports.app}/readyz`, {
          signal: AbortSignal.timeout(1000),
        })
        return response.status === 200
      } catch {
        return false
      }
    }
    async function startApp() {
      const current = launchApp()
      await until(
        async () => {
          if (!current.running) throw new Error('Farm app exited at startup')
          return ready()
        },
        30000,
        'farm app ready',
      )
      assert.ok(current.running, 'farm app alive after readiness')
    }
    closers.push(async () => {
      await app?.stop()
    })

    let connector: ReturnType<typeof startConnector> | undefined
    const connectorLog = join(workDir, 'connector.log')
    const expected: number[] = [] // Every observation the fixture caused, as progress values.
    function launchConnector() {
      connector = startConnector({
        args: [
          ...['--config', configPath, '--credential-file', credentialPath],
          ...['--data-dir', dataDir],
        ],
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          NODE_EXTRA_CA_CERTS: cert,
        },
        logPath: connectorLog,
        onPid: (pid) => ledger({ resource: 'connector-process', pid }),
      })
      return connector
    }
    async function startConnectorAndBaseline(timeoutMs = 30000) {
      const current = launchConnector()
      // The first subscription snapshot after each start is a new observation.
      await until(
        () => {
          if (!current.running) throw new Error('Connector exited at startup')
          return current.count('queued') >= 1
        },
        timeoutMs,
        'connector baseline queued',
      )
      expected.push(moon.progress)
      assert.ok(current.running, 'connector alive after baseline')
      return current
    }
    closers.push(async () => {
      await connector?.stop()
    })
    let step = 0
    async function push(count: number) {
      const current = connector
      if (!current) throw new Error('Connector not running')
      for (let index = 0; index < count; index++) {
        const before = current.count('queued')
        const progress = ++step / 1000
        moon.push(progress)
        expected.push(progress)
        await until(
          () => current.count('queued') > before,
          10000,
          'observation queued',
        )
      }
    }
    async function rows() {
      return (await admin`SELECT event_id::text AS id, payload FROM farm.telemetry_events WHERE agent_id=${agentId}::uuid`) as unknown as {
        id: string
        payload: Record
      }[]
    }
    const queueLines = () =>
      readFileSync(queueFile, 'utf8').split('\n').filter(Boolean)
    async function drained(timeoutMs = 60000) {
      const start = performance.now()
      await until(
        async () =>
          (await rows()).length >= expected.length &&
          statSync(queueFile).size === 0,
        timeoutMs,
        'queue drained into database',
      )
      return Math.round(performance.now() - start)
    }
    function maxAttemptGap(from: number, to: number) {
      const attempts = proxy.log
        .filter((e) => e.route === 'challenge' && e.at >= from && e.at <= to)
        .map((e) => e.at)
      let gap = 0
      for (let i = 1; i < attempts.length; i++)
        gap = Math.max(gap, attempts[i]! - attempts[i - 1]!)
      return { attempts: attempts.length, maxGapMs: Math.round(gap) }
    }
    async function scenario(name: string, body: () => Promise<object>) {
      const start = performance.now()
      const result = await body()
      assert.deepEqual(handlerErrors, [], 'event handler errors')
      const entry = {
        name,
        result: 'passed',
        durationMs: Math.round(performance.now() - start),
        ...result,
      }
      report.scenarios.push(entry)
      appendFileSync(
        join(workDir, 'progress.jsonl'),
        JSON.stringify(entry) + '\n',
      )
    }

    await startApp()
    await startConnectorAndBaseline()
    await drained()

    await scenario('1-server-process-down', async () => {
      const first = connector!
      await app!.stop()
      const outageStart = performance.now()
      await push(10)
      await until(
        () => first.count('delivery', (d) => d.status === 'retained') >= 2,
        20000,
        'retained attempts while server is down',
      )
      // Durability: a graceful Connector restart during the outage keeps the queue.
      await first.stop()
      assert.deepEqual(await first.exited, { code: 0, signal: null })
      const persisted = queueLines().length
      assert.ok(persisted >= 10, 'queued records persisted across restart')
      const second = await startConnectorAndBaseline()
      const backoffFrom = performance.now()
      await push(5)
      await new Promise((r) => setTimeout(r, 8000))
      const backoff = maxAttemptGap(backoffFrom, performance.now())
      assert.ok(backoff.attempts >= 2, 'Connector keeps retrying')
      assert.ok(backoff.maxGapMs <= MAX_ATTEMPT_GAP_MS, 'bounded backoff')
      const outageMs = Math.round(performance.now() - outageStart)
      await startApp()
      const drainMs = await drained()
      assert.ok(second.running, 'Connector survived the outage')
      return { outageMs, persistedAcrossRestart: persisted, backoff, drainMs }
    })

    await scenario('5-network-blip-shorter-than-backoff', async () => {
      const current = connector!
      const retainedBefore = current.count(
        'delivery',
        (d) => d.status === 'retained',
      )
      const from = proxy.log.length
      proxy.setMode('reset')
      const blipStart = performance.now()
      await push(1)
      await until(
        () => proxy.log.slice(from).some((e) => e.outcome === 'reset'),
        10000,
        'blip observed by an attempt',
      )
      proxy.setMode('pass')
      const blipMs = Math.round(performance.now() - blipStart)
      const recoveryMs = await drained(20000)
      assert.ok(
        current.count('delivery', (d) => d.status === 'retained') >
          retainedBefore,
      )
      assert.ok(
        recoveryMs <= MAX_ATTEMPT_GAP_MS,
        'recovered within one backoff',
      )
      assert.ok(current.running)
      return { blipMs, recoveryMs }
    })

    await scenario('2-database-unavailable-and-startup-gate-503', async () => {
      const current = connector!
      await input.docker('pause', input.container)
      const outageStart = performance.now()
      let paused = true
      try {
        await push(3)
        await new Promise((r) => setTimeout(r, 4000))
        await app!.stop()
        // Restart while PostgreSQL is frozen: the gate must answer 503 until it decides.
        let gate503 = 0,
          startupExitCode: number | null | undefined,
          restarts = 0
        while (gate503 === 0 && restarts < 3) {
          restarts++
          const from = proxy.log.length
          const attempt = launchApp()
          await until(
            () =>
              !attempt.running ||
              proxy.log.slice(from).some((e) => e.outcome === 503),
            20000,
            'startup gate observed',
          )
          gate503 = proxy.log
            .slice(from)
            .filter((e) => e.outcome === 503).length
          if (!attempt.running) startupExitCode = await attempt.exited
        }
        assert.ok(gate503 >= 1, 'Connector observed the startup gate 503')
        await new Promise((r) => setTimeout(r, 3000))
        await input.docker('unpause', input.container)
        paused = false
        // The same gated process must recover on its own: no restart fallback.
        const gated = app!
        assert.ok(gated.running, 'gated server still running after unpause')
        await until(
          async () => {
            if (!gated.running) throw new Error('Gated server exited')
            return ready()
          },
          30000,
          'gated server becomes ready',
        )
        assert.ok(gated.running && (await ready()))
        const outageMs = Math.round(performance.now() - outageStart)
        const backoff = maxAttemptGap(outageStart, performance.now())
        assert.ok(backoff.maxGapMs <= MAX_ATTEMPT_GAP_MS, 'bounded backoff')
        const drainMs = await drained()
        assert.ok(current.running, 'Connector survived database outage')
        return {
          outageMs,
          gate503Responses: gate503,
          gatedStartupExitCode: startupExitCode ?? null,
          appRestarts: restarts,
          backoff,
          drainMs,
        }
      } finally {
        if (paused) await input.docker('unpause', input.container)
      }
    })

    await scenario('3-connector-sigkill-after-commit-before-ack', async () => {
      const victim = connector!
      const held = proxy.holdNextCommit()
      await push(3)
      const { eventIds, release } = await held
      const killedPid = victim.child.pid
      await victim.kill()
      release()
      const committed = await rows()
      for (const id of eventIds)
        assert.equal(committed.filter((r) => r.id === id).length, 1)
      const stillQueued = new Set(
        queueLines().map((l) => (JSON.parse(l) as Record).eventId),
      )
      assert.ok(
        eventIds.every((id) => stillQueued.has(id)),
        'ack was lost',
      )
      // Restart: the queue lock left by SIGKILL is never removed automatically.
      let operatorLockRecovery = false
      const blocked = launchConnector()
      const outcome = await blocked.exited
      if (
        outcome.code === 1 &&
        existsSync(lockFile) &&
        // The CLI's fixed local-collection failure text (pt-BR), not a crash.
        blocked.stderr.includes('Não foi possível manter a coleta local')
      ) {
        const owner = JSON.parse(readFileSync(lockFile, 'utf8')) as {
          pid: number
        }
        assert.equal(
          owner.pid,
          killedPid,
          'stale lock belongs to reaped process',
        )
        unlinkSync(lockFile) // Documented operator step, exact path only.
        operatorLockRecovery = true
      } else
        assert.fail('unexpected restart outcome ' + JSON.stringify(outcome))
      const restartAt = performance.now()
      await startConnectorAndBaseline()
      const drainMs = await drained()
      const replays = proxy.log.filter(
        (e) =>
          e.route === 'commit' &&
          e.at >= restartAt &&
          e.outcome === 200 &&
          eventIds.every((id) => e.eventIds?.includes(id)),
      ).length
      assert.ok(replays >= 1, 'replayed batch accepted')
      const after = await rows()
      for (const id of eventIds)
        assert.equal(after.filter((r) => r.id === id).length, 1, 'no duplicate')
      if (operatorLockRecovery)
        report.findings.push(
          'After SIGKILL the queue lock (telemetry.lock) blocks restart (exit 1) until an operator removes it; unattended restart after a crash is not automatic.',
        )
      return {
        heldEventIds: eventIds.length,
        operatorLockRecovery,
        replays,
        drainMs,
      }
    })

    await scenario('exactly-once-and-order-summary', async () => {
      const stored = await rows()
      assert.equal(stored.length, expected.length, 'no loss, no extra rows')
      const sortNumbers = (v: number[]) => [...v].sort((a, b) => a - b)
      assert.deepEqual(
        sortNumbers(stored.map((r) => r.payload.state?.progress ?? -1)),
        sortNumbers(expected),
        'each observation stored exactly once',
      )
      const byId = new Map(stored.map((r) => [r.id, r.payload]))
      const sent: string[] = []
      const seen = new Set<string>()
      let resent = 0
      for (const entry of proxy.log)
        for (const id of entry.route === 'commit' ? (entry.eventIds ?? []) : [])
          if (seen.has(id)) resent++
          else {
            seen.add(id)
            sent.push(id)
          }
      assert.deepEqual([...seen].sort(), [...byId.keys()].sort())
      const order = sent.map((id) => byId.get(id)!)
      for (let i = 1; i < order.length; i++) {
        assert.ok(order[i]!.queuedAt >= order[i - 1]!.queuedAt, 'FIFO order')
        assert.ok(
          order[i]!.state!.progress >= order[i - 1]!.state!.progress,
          'per-printer order',
        )
      }
      return { rows: stored.length, resentRecordAttempts: resent }
    })

    await scenario('4-queue-cap-during-long-outage', async () => {
      await app!.stop()
      await push(3)
      await connector!.stop()
      assert.equal((await connector!.exited).code, 0)
      const existing = queueLines()
      const template = JSON.parse(existing.at(-1)!) as Record
      const line = (eventId: string) =>
        JSON.stringify({
          ...template,
          eventId,
          state: { ...template.state, progress: 0 },
        })
      const size = Buffer.byteLength(line(randomUUID()) + '\n')
      const existingBytes = existing.reduce(
        (n, l) => n + Buffer.byteLength(l) + 1,
        0,
      )
      const seededCount = Math.floor((QUEUE_MAX_BYTES - existingBytes) / size)
      const seeded = Array.from({ length: seededCount }, () => randomUUID())
      // Synthetic backlog in canonical queue format, oldest first, in place (same inode).
      writeFileSync(
        queueFile,
        seeded.map((id) => line(id) + '\n').join('') +
          existing.map((l) => l + '\n').join(''),
      )
      const fullBytes = statSync(queueFile).size
      assert.ok(fullBytes <= QUEUE_MAX_BYTES)
      const openStart = performance.now()
      const current = await startConnectorAndBaseline(120000)
      const openMs = Math.round(performance.now() - openStart)
      await push(4)
      await until(
        () => current.count('loss', (d) => d.phase === 'retention') >= 1,
        30000,
        'capacity loss diagnostic',
      )
      const evicted = current.diagnostics
        .filter((d) => d.kind === 'loss')
        .reduce((n, d) => n + Number(d.capacity), 0)
      assert.ok(evicted >= 1)
      const lines = queueLines().map((l) => (JSON.parse(l) as Record).eventId)
      assert.ok(statSync(queueFile).size <= QUEUE_MAX_BYTES)
      assert.equal(lines[0], seeded[evicted], 'oldest records evicted first')
      const kept = new Set(lines)
      assert.ok(seeded.slice(0, evicted).every((id) => !kept.has(id)))
      assert.ok(
        existing.every((l) => kept.has((JSON.parse(l) as Record).eventId)),
        'newer records retained',
      )
      // Server returns: drain must make bounded progress without a crash.
      await startApp()
      const drainStart = performance.now()
      const logFrom = proxy.log.length
      await until(
        () => current.count('delivery', (d) => d.status === 'delivered') >= 3,
        60000,
        'drain progress on a full queue',
      )
      await new Promise((r) => setTimeout(r, 20000))
      const seconds = (performance.now() - drainStart) / 1000
      const delivered = current.diagnostics
        .filter((d) => d.kind === 'delivery' && d.status === 'delivered')
        .reduce((n, d) => n + Number(d.count), 0)
      assert.ok(current.running, 'no crash while draining a full queue')
      const first =
        await admin`SELECT count(*)::int AS n FROM farm.telemetry_events WHERE agent_id=${agentId}::uuid AND event_id=${seeded[evicted]!}::uuid`
      assert.equal(first[0]?.n, 1, 'oldest retained record delivered')
      const firstCommit = proxy.log
        .slice(logFrom)
        .find((e) => e.route === 'commit' && e.outcome === 200)
      assert.equal(
        firstCommit?.eventIds?.[0],
        seeded[evicted],
        'oldest retained record is the first committed after restart',
      )
      await current.stop()
      assert.equal((await current.exited).code, 0)
      const drainRecordsPerSecond = Math.round(delivered / seconds)
      const backlogDrainEstimateS = Math.round(
        lines.length / Math.max(1, delivered / seconds),
      )
      report.findings.push(
        `Full-queue drain rate ${drainRecordsPerSecond} records/s (estimated ${backlogDrainEstimateS} s for ${lines.length} records); each acknowledgement rewrites and fsyncs the whole queue file.`,
      )
      return {
        seededRecords: seededCount,
        queueBytes: fullBytes,
        reopenMs: openMs,
        evicted,
        drainRecordsPerSecond,
        backlogDrainEstimateS,
      }
    })

    report.scenarios.push({
      name: '6-credential-renewal-across-outage',
      result: 'skipped',
      reason:
        'Not implemented in this runner yet: server renewal activation landed in #132 after this runner was written; renewal across an outage is a follow-up scenario.',
    })
    return report
  } finally {
    const failures: string[] = []
    for (const close of closers.reverse())
      await close().catch(() => failures.push('process or listener'))
    for (const pool of pools)
      await pool.end({ timeout: 3 }).catch(() => failures.push('pool'))
    for (const role of created.reverse())
      await admin`DROP ROLE ${admin(role)}`.catch(() =>
        failures.push('role ' + role),
      )
    ledger({
      cleanup: failures.length ? 'incomplete' : 'scenario resources removed',
      failures,
    })
  }
}
