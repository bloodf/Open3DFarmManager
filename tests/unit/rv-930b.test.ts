import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TransactionSql } from 'postgres'
import { describe, expect, it } from 'vitest'
import { recordInventorySnapshot } from '../../apps/farm/server/storage/postgres-inventory-snapshot.ts'
import { createAuthenticatedTelemetrySender } from '../../packages/connector/src/cloud/authenticated-http-telemetry.ts'
import { drainTelemetryOnce } from '../../packages/connector/src/cloud/drain.ts'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { createAnycubicCollection } from '../../packages/connector/src/runtime/anycubic-collection.ts'
import { TelemetryBatch } from '../../packages/farm-protocol/src/telemetry.ts'
import type { PrinterState } from '../../packages/farm-protocol/src/state.ts'

/** The printer state the Anycubic collector reports after a stopped job. */
async function stoppedIdleState(directory: string): Promise<PrinterState> {
  const passwordFile = join(directory, 'password.json')
  writeFileSync(passwordFile, JSON.stringify('synthetic'), { mode: 0o600 })
  const controller = new AbortController()
  let last: PrinterState | undefined
  let report: (payload: unknown) => void = () => {}
  const collection = createAnycubicCollection({
    binding: {
      printerKey: 'simulator',
      host: '127.0.0.1',
      port: 9883,
      modelId: '20024',
      deviceId: 'SYNTHETIC',
      username: 'test',
      passwordFile,
    },
    signal: controller.signal,
    onObservation: (value) => {
      last = value.printer as PrinterState
    },
    onUnavailable() {},
    transport(options) {
      report = (payload) =>
        options.onReport(Buffer.from(JSON.stringify(payload)))
      return { done: Promise.resolve(), close: async () => {} }
    },
  })
  try {
    report({ data: { state: 'printing', progress: 40 } })
    expect(last?.progress).toBe(0.4)
    report({ type: 'print', action: 'stop', state: 'stoped', code: 10601 })
    report({ data: { state: 'free', project: null } })
    return last!
  } finally {
    controller.abort()
    await collection.done
  }
}

type Wire = {
  eventId: string
  ageAtSendMs?: number
  state: { state: string; progress?: number }
}[]

/** A server that refuses, with HTTP 400, the shapes its release did not know. */
async function telemetryServer(release: { progress: boolean; age: boolean }) {
  const agentId = randomUUID(),
    farmId = randomUUID(),
    token = 'aaa.bbb.ccc',
    audience = 'fixture'
  const spki = generateKeyPairSync('ed25519').publicKey.export({
    type: 'spki',
    format: 'der',
  })
  const challenged: Wire[] = []
  const committed: Wire[] = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks)
    const records = JSON.parse(body.toString()) as Wire
    res.setHeader('content-type', 'application/json')
    if (!req.url?.endsWith('/challenge')) {
      committed.push(records)
      res.end(
        JSON.stringify({
          ok: true,
          acceptedEventIds: records.map(({ eventId }) => eventId),
        }),
      )
      return
    }
    challenged.push(records)
    const refused =
      !TelemetryBatch.safeParse(records).success ||
      records.some(
        (record) =>
          (!release.age && record.ageAtSendMs !== undefined) ||
          (release.progress &&
            record.state.state !== 'offline' &&
            record.state.progress === undefined),
      )
    if (refused) {
      res.writeHead(400)
      res.end('{}')
      return
    }
    const now = Date.now()
    res.end(
      JSON.stringify({
        challenge: {
          v: 2,
          purpose: 'telemetry-ingestion',
          method: 'POST',
          path: '/api/connector/telemetry',
          agent_id: agentId,
          farm_id: farmId,
          jti: randomUUID(),
          connection_id: randomUUID(),
          public_key_spki: spki.toString('base64url'),
          fingerprint:
            'SHA256:' + createHash('sha256').update(spki).digest('base64url'),
          thumbprint: 'A'.repeat(43),
          token_hash: createHash('sha256').update(token).digest('base64url'),
          origin: 'https://farm.example',
          audience,
          generation: 1,
          nonce: 'A'.repeat(43),
          issued_at: now,
          expires_at: now + 5000,
          body_sha256: createHash('sha256').update(body).digest('base64url'),
          body_bytes: body.length,
        },
      }),
    )
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as { port: number }
  const send = createAuthenticatedTelemetrySender({
    endpoint: `http://127.0.0.1:${address.port}/api/connector/telemetry`,
    token,
    agentId,
    farmId,
    audience,
    timeoutMs: 5000,
    allowLoopbackHttpForTests: true,
    identity: { signTelemetryProof: () => 'A'.repeat(86) },
  })
  return {
    send,
    challenged,
    committed,
    close() {
      server.closeAllConnections()
      server.close()
    },
  }
}

describe('idle progress across server releases', () => {
  it.each([
    {
      name: 'current server',
      release: { progress: false, age: true },
      requests: 1,
      progress: undefined,
      age: true,
    },
    {
      name: 'server that requires progress and knows the send age',
      release: { progress: true, age: true },
      requests: 2,
      progress: 0,
      age: true,
    },
    {
      name: 'server older than both',
      release: { progress: true, age: false },
      requests: 3,
      progress: 0,
      age: false,
    },
  ])(
    '$name accepts a stopped, idle printer',
    async ({ release, requests, progress, age }) => {
      const directory = mkdtempSync(join(tmpdir(), 'rv-930b-'))
      const queue = new TelemetryQueue(directory, Date.now())
      const server = await telemetryServer(release)
      try {
        const state = await stoppedIdleState(directory)
        expect(state.state).toBe('idle')
        expect(state.progress).toBeUndefined()
        queue.enqueue(state, Date.now())
        const result = await drainTelemetryOnce(
          queue,
          server.send,
          Date.now,
          new AbortController().signal,
        )
        expect(result.status).toBe('delivered')
        expect(queue.depth).toBe(0)
        // The current shape is always offered first.
        expect(server.challenged[0]![0]!.state).not.toHaveProperty('progress')
        expect(server.challenged).toHaveLength(requests)
        const [accepted] = server.committed[0]!
        expect(accepted!.state.progress).toBe(progress)
        expect(accepted!.ageAtSendMs !== undefined).toBe(age)
      } finally {
        server.close()
        queue.close()
        await rm(directory, { recursive: true, force: true })
      }
    },
  )

  it('never adds progress to a printer that is not idle', async () => {
    const server = await telemetryServer({ progress: true, age: true })
    const body = JSON.stringify([
      {
        eventId: randomUUID(),
        queuedAt: 1,
        kind: 'printer-state',
        state: {
          printerKey: 'simulator',
          state: 'error',
          statusReason: 'firmware-shutdown',
          observedAt: 1,
        },
      },
    ])
    try {
      await expect(
        server.send(body, new AbortController().signal),
      ).rejects.toThrow('Telemetry transport failed')
      expect(server.challenged).toHaveLength(1)
      expect(server.committed).toHaveLength(0)
    } finally {
      server.close()
    }
  })
})

describe('Spoolman observation statement order', () => {
  it('locks snapshot rows before settings rows in the current lock function', () => {
    const directory = new URL('../../infra/db/migrations/', import.meta.url)
    // The last migration that defines the function is the one in force.
    const body = readdirSync(directory)
      .filter((name) => name.endsWith('.up.sql'))
      .sort()
      .flatMap((name) => {
        const sql = readFileSync(new URL(name, directory), 'utf8')
        const match =
          /FUNCTION farm\.lock_spool_observation_provenance\([\s\S]*?AS \$\$([\s\S]*?)\$\$;/.exec(
            sql,
          )
        return match ? [match[1]!] : []
      })
      .at(-1)!
    const statements = body
      .replace(/--.*$/gm, '')
      .split(';')
      .map((statement) => statement.replace(/\s+/g, ' ').trim())
    const locking = statements.filter((statement) =>
      /\bFOR (SHARE|UPDATE|KEY SHARE|NO KEY UPDATE)\b/.test(statement),
    )
    expect(locking).toHaveLength(2)
    expect(locking[0]).toContain('farm.connector_inventory_snapshots')
    expect(locking[0]).not.toContain('farm.spoolman_connector_settings')
    expect(locking[1]).toContain('farm.spoolman_connector_settings')
    expect(locking[1]).not.toContain('farm.connector_inventory_snapshots')
  })

  it('writes a snapshot with one statement that never locks settings itself', async () => {
    const statements: string[] = []
    const tx = Object.assign(
      async (parts: TemplateStringsArray) => {
        statements.push(parts.join('?'))
        return []
      },
      { json: (value: unknown) => value },
    )
    await recordInventorySnapshot(
      tx as unknown as TransactionSql,
      { farmId: randomUUID(), agentId: randomUUID() },
      { observedAt: 1, stale: false, total: 0, spools: [] },
    )
    expect(statements).toHaveLength(1)
    expect(statements[0]).toMatch(
      /^INSERT INTO farm\.connector_inventory_snapshots/,
    )
    expect(statements[0]).not.toContain('spoolman_connector_settings')
  })
})
