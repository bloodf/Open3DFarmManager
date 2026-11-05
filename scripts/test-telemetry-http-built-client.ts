// Synthetic child process for the caller-owned built-app integration fixture.
import assert from 'node:assert/strict'
import { createPrivateKey } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { ConnectorIdentity } from '../packages/connector/src/identity/store.ts'
import { TelemetryQueue } from '../packages/connector/src/cloud/queue.ts'
import { drainTelemetryOnce } from '../packages/connector/src/cloud/drain.ts'
import { createAuthenticatedTelemetrySender } from '../packages/connector/src/cloud/authenticated-http-telemetry.ts'

if (process.version !== 'v24.20.0') throw new Error('Node 24.20.0 is required')
const path = process.env.TELEMETRY_HTTP_BUILT_FIXTURE
const phase = process.env.TELEMETRY_HTTP_BUILT_PHASE
if (
  process.argv.length !== 2 ||
  !path ||
  (phase !== 'deliver' && phase !== 'revoked')
)
  throw new Error('Explicit synthetic fixture required')
const input: unknown = JSON.parse(await readFile(path, 'utf8'))
if (
  !input ||
  typeof input !== 'object' ||
  !('endpoint' in input) ||
  typeof input.endpoint !== 'string' ||
  !('token' in input) ||
  typeof input.token !== 'string' ||
  !('agentId' in input) ||
  typeof input.agentId !== 'string' ||
  !('farmId' in input) ||
  typeof input.farmId !== 'string' ||
  !('audience' in input) ||
  typeof input.audience !== 'string' ||
  !('privateKey' in input) ||
  typeof input.privateKey !== 'string' ||
  !('queueDir' in input) ||
  typeof input.queueDir !== 'string'
)
  throw new Error('Invalid synthetic fixture')
const identity = new ConnectorIdentity(createPrivateKey(input.privateKey))
const queue = new TelemetryQueue(input.queueDir, Date.now())
try {
  const sender = createAuthenticatedTelemetrySender({
    endpoint: input.endpoint,
    token: input.token,
    agentId: input.agentId,
    farmId: input.farmId,
    audience: input.audience,
    timeoutMs: 5000,
    identity,
  })
  const eventId = queue.enqueue(
    {
      printerKey: 'simulator',
      state: 'idle',
      progress: 0,
      observedAt: Date.now(),
    },
    Date.now(),
  ).eventId
  if (phase === 'deliver') {
    assert.equal(
      (
        await drainTelemetryOnce(
          queue,
          sender,
          Date.now,
          new AbortController().signal,
        )
      ).status,
      'retained',
    )
    assert.equal(queue.depth, 1)
    await new Promise((resolve) => setTimeout(resolve, 1100))
    assert.equal(
      (
        await drainTelemetryOnce(
          queue,
          sender,
          Date.now,
          new AbortController().signal,
        )
      ).status,
      'delivered',
    )
    assert.equal(queue.depth, 0)
  } else {
    await new Promise((resolve) => setTimeout(resolve, 1100))
    assert.equal(
      (
        await drainTelemetryOnce(
          queue,
          sender,
          Date.now,
          new AbortController().signal,
        )
      ).status,
      'retained',
    )
    assert.equal(queue.depth, 1)
  }
  console.log(
    JSON.stringify({
      phase,
      eventId,
      depth: queue.depth,
      runtime: process.version,
    }),
  )
} finally {
  queue.close()
}
