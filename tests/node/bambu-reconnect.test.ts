import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { startBambuSimulator } from '../../packages/sim-tools/src/bambu-simulator.ts'
import { createBambuTransport } from '../../packages/connector/src/bambu/transport.ts'

test(
  'healthy subscribed sessions replenish retries; failures remain bounded',
  { timeout: 10000 },
  async () => {
    const simulator = await startBambuSimulator()
    const states: string[] = []
    const reports: string[] = []
    const bootstrapReports: string[] = []
    const abort = new AbortController()
    const transport = createBambuTransport({
      host: simulator.host,
      port: simulator.port,
      serial: 'SYNTHETIC',
      credentials: { username: 'bblp', password: 'synthetic' },
      caPem: simulator.syntheticTrust,
      limits: {
        maxFrameBytes: 4096,
        connectTimeoutMs: 200,
        maxInflight: 1,
        reconnectDelayMs: 10,
        maxReconnects: 2,
      },
      signal: abort.signal,
      onConnection: (state) => states.push(state),
      onReport: (payload) => {
        const report = payload.toString()
        if ('print' in JSON.parse(report)) bootstrapReports.push(report)
        else reports.push(report)
      },
    })
    async function until(predicate: () => boolean) {
      for (let i = 0; i < 200 && !predicate(); i++) await delay(10)
      assert.ok(predicate(), JSON.stringify({ states, reports }))
    }
    try {
      for (let session = 1; session <= 5; session++) {
        await until(
          () => states.filter((s) => s === 'connected').length === session,
        )
        // With no initial gcode state, the simulator emits one report in
        // response to pushall and no periodic updates.
        await until(() => bootstrapReports.length === session)
        assert.equal(
          JSON.parse(bootstrapReports[session - 1]!).print.mc_percent,
          25,
        )
        simulator.publishReport({ session })
        await until(() => reports.length === session)
        assert.deepEqual(JSON.parse(reports[session - 1]!), { session })
        await delay(30)
        if (session < 5) await simulator.disconnectClients()
      }
      const before = states.filter((s) => s === 'disconnected').length
      await simulator.close()
      await transport.done
      assert.equal(bootstrapReports.length, 5)
      assert.equal(reports.length, 5)
      assert.deepEqual(
        simulator.queries,
        Array.from({ length: 5 }, () => [
          { command: 'pushall', sequence_id: '0' },
          { command: 'get_version', sequence_id: '0' },
        ]).flat(),
      )
      assert.deepEqual(simulator.requests, [])
      assert.equal(
        states.filter((s) => s === 'disconnected').length - before,
        3,
      )
      assert.equal(states.at(-1), 'closed')
      const count = states.length
      abort.abort()
      await transport.close()
      await delay(50)
      assert.equal(states.length, count)
    } finally {
      await transport.close()
      await simulator.close()
    }
  },
)
