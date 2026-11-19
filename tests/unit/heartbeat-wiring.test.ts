import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtempSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import type { TransactionSql } from 'postgres'
import { startHttpMock } from '../../packages/sim-tools/src/mocks/http-mock.ts'
import { withNetworkGuard } from '../../packages/sim-tools/src/mocks/network-guard.ts'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { createAuthenticatedTelemetrySender } from '../../packages/connector/src/cloud/authenticated-http-telemetry.ts'
import { drainTelemetryOnce } from '../../packages/connector/src/cloud/drain.ts'
import { createTelemetryHttpHandler } from '../../apps/farm/server/services/telemetry-http.ts'
import { prepareTelemetryOperation } from '../../apps/farm/server/services/telemetry-operation.ts'
import { recordNetworkTelemetry } from '../../apps/farm/server/storage/postgres-farm-network.ts'
import { farmNetwork } from '../../apps/farm/server/services/farm-network.ts'
import type { AuthRuntime } from '../../apps/farm/server/utils/auth/runtime.ts'

vi.mock('../../apps/farm/server/services/authenticated-session.ts', () => ({
  authResponse: () => {},
  sealedSessionRecordId: async () => 'network-session',
}))

test('Connector uploads heartbeat and discovery and the network route returns them', async () => {
  const farmId = randomUUID()
  const agentId = randomUUID()
  const jti = randomUUID()
  const token = 'aaa.bbb.ccc'
  const audience = 'synthetic-audience'
  const now = Date.now()
  const spki = generateKeyPairSync('ed25519').publicKey.export({
    type: 'spki',
    format: 'der',
  })
  const connector = {
    version: '1.2.3',
    uptimeMs: 5000,
    queueBacklog: 1,
    storage: 'healthy',
    rtcScope: 'lan',
  } as const
  const printer = {
    printerKey: 'fixture',
    state: 'connected',
    lastSuccessAt: now,
    p50Ms: 10,
    p95Ms: 20,
    reconnects: 0,
    lastErrorCode: null,
  } as const
  const discovery = {
    vendor: 'moonraker',
    host: '127.0.0.1',
    port: 7125,
    serial: 'fixture-serial',
    name: 'Fixture',
    model: null,
    firstSeen: now,
    lastSeen: now,
    adopted: false,
  } as const
  const writes = new Map<string, unknown[]>()
  const tx = Object.assign(
    async (sql: TemplateStringsArray, ...values: unknown[]) => {
      writes.set(sql[0]!.split(' ')[2]!, values)
    },
    { json: (value: unknown) => value },
  ) as unknown as TransactionSql

  const handler = createTelemetryHttpHandler(
    {
      async issueTelemetryChallenge(input, raw) {
        const { connectionId } = input as { connectionId: string }
        const issuedAt = Date.now()
        return {
          ok: true,
          kind: 'challenge',
          challenge: {
            v: 2,
            purpose: 'telemetry-ingestion',
            method: 'POST',
            path: '/api/connector/telemetry',
            agent_id: agentId,
            farm_id: farmId,
            jti,
            connection_id: connectionId,
            public_key_spki: spki.toString('base64url'),
            fingerprint:
              'SHA256:' + createHash('sha256').update(spki).digest('base64url'),
            thumbprint: 'A'.repeat(43),
            token_hash: createHash('sha256').update(token).digest('base64url'),
            origin: 'https://farm.example',
            audience,
            generation: 1,
            nonce: 'A'.repeat(43),
            issued_at: issuedAt,
            expires_at: issuedAt + 5000,
            body_sha256: createHash('sha256')
              .update(raw as Uint8Array)
              .digest('base64url'),
            body_bytes: (raw as Uint8Array).byteLength,
          },
        }
      },
      async commitTelemetryWithProof(input, raw) {
        expect(input).toMatchObject({
          farmId,
          agentId,
          token,
          signature: 'A'.repeat(86),
        })
        const { records } = prepareTelemetryOperation(raw)
        await recordNetworkTelemetry(tx, { farmId, agentId }, records)
        return {
          ok: true,
          kind: 'telemetry-committed',
          jti,
          acceptedEventIds: records.map(({ eventId }) => eventId),
          acceptedAt: Date.now(),
          expiresAt: Date.now() + 1000,
        }
      },
    },
    2000,
  )
  const directory = mkdtempSync(join(tmpdir(), 'openfarm-416-'))
  const queue = new TelemetryQueue(directory, now)
  const server = await withNetworkGuard(() =>
    startHttpMock({
      port: 0,
      async streamingHandler(req, res) {
        res.setHeader('content-type', 'application/json')
        try {
          if (req.url === `/api/farms/${farmId}/network`) {
            const body = await farmNetwork(
              {
                req: new Request('http://127.0.0.1' + req.url),
                res: { headers: new Headers() },
              } as Parameters<typeof farmNetwork>[0],
              farmId,
              {
                auth: { idleTimeoutMs: 1000 } as AuthRuntime,
                reader: {
                  async read() {
                    const heartbeat = writes.get('farm.connector_heartbeats')
                    const report = writes.get('farm.connector_discoveries')
                    return {
                      ok: true,
                      role: 'owner',
                      connectors: [
                        {
                          agentId,
                          fingerprint: 'fixture',
                          status: 'approved',
                          lastSeenAt: Number(heartbeat?.[2]),
                          health: heartbeat?.[3],
                        },
                      ],
                      printers: [
                        {
                          assignmentId: randomUUID(),
                          agentId,
                          printerKey: printer.printerKey,
                          displayName: null,
                        },
                      ],
                      discoveries: report
                        ? [
                            {
                              agentId,
                              observedAt: Number(report[2]),
                              printers: report[3],
                            },
                          ]
                        : [],
                    }
                  },
                },
              },
            )
            res.end(JSON.stringify(body))
          } else {
            const response = await handler({ '~app': { node: { req } } })
            res.statusCode = response.status
            res.end(JSON.stringify(response.body))
          }
        } catch {
          res.statusCode = 500
          res.end('{}')
        }
      },
    }),
  )
  try {
    queue.enqueueHeartbeat({ connector, printers: [printer] }, now)
    queue.enqueueDiscovery([discovery], now)
    const send = createAuthenticatedTelemetrySender({
      endpoint: server.origin + '/api/connector/telemetry',
      token,
      farmId,
      agentId,
      audience,
      timeoutMs: 2000,
      allowLoopbackHttpForTests: true,
      identity: { signTelemetryProof: () => 'A'.repeat(86) },
    })
    for (let upload = 0; upload < 2; upload++)
      await drainTelemetryOnce(
        queue,
        send,
        () => now,
        new AbortController().signal,
      )
    expect(queue.depth).toBe(0)
    const response = await fetch(`${server.origin}/api/farms/${farmId}/network`)
    expect(response.status).toBe(200)
    const network = await response.json()
    expect(network.connectors[0]).toMatchObject({
      agentId,
      lastSeenAt: now,
      health: connector,
    })
    const { printerKey, ...link } = printer
    expect(network.printers[0]).toMatchObject({ agentId, printerKey, link })
    expect(network.discovered[0]).toMatchObject({
      host: discovery.host,
      serial: discovery.serial,
    })
  } finally {
    await server.close()
    queue.close()
    for (const entry of readdirSync(directory))
      unlinkSync(join(directory, entry))
    rmdirSync(directory)
  }
})
