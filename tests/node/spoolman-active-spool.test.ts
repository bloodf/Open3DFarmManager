import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectIntoQueue } from '../../packages/connector/src/runtime/collect.ts'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { moonrakerSpoolmanFixture } from '../../packages/connector/test/moonraker-spoolman-fixture.ts'
import type { RawPrinterObservation } from '../../packages/connector/src/runtime/farm-snapshot-provider.ts'

for (const auth of ['key', 'jwt'] as const) {
  test(
    `active Spoolman spool through collection with ${auth}`,
    { timeout: 10000 },
    async (t) => {
      const fixture = await moonrakerSpoolmanFixture()
      const dir = mkdtempSync(join(tmpdir(), 'active-spool-'))
      const credential = join(dir, 'credential.json')
      writeFileSync(
        credential,
        JSON.stringify(
          auth === 'key'
            ? { origin: fixture.origin, apiKey: 'test-key' }
            : { origin: fixture.origin, username: 'test', password: 'secret' },
        ),
        { mode: 0o600 },
      )
      const queue = new TelemetryQueue(join(dir, 'queue'), Date.now())
      const controller = new AbortController()
      const observations: RawPrinterObservation[] = []
      let inventory = false
      let offset = 0
      const realNow = performance.now.bind(performance)
      t.mock.method(performance, 'now', () => realNow() + offset)
      const done = collectIntoQueue({
        config: {
          version: 1,
          allowedOrigins: [fixture.origin],
          printers: [
            {
              printerKey: 'printer',
              origin: fixture.origin,
              apiKeyFile: credential,
            },
          ],
          limits: {
            maxMessageBytes: 4096,
            connectTimeoutMs: 1000,
            requestTimeoutMs: 1000,
            staleAfterMs: 30000,
            reconnectMinMs: 100,
            reconnectMaxMs: 1000,
          },
          spoolman: {
            origin: fixture.origin,
            farmId: '00000000-0000-4000-8000-000000000001',
            serviceId: '00000000-0000-4000-8000-000000000002',
            limit: 200,
          },
        },
        queue,
        signal: controller.signal,
        onDiagnostic() {},
        onInventory(value) {
          if (value.kind === 'observed') inventory = true
        },
        onRawObservation(value) {
          observations.push(value)
        },
      })
      async function waitFor(predicate: () => boolean) {
        const deadline = Date.now() + 4000
        while (!predicate()) {
          if (Date.now() > deadline)
            throw Error('Timed out waiting for collection')
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      }
      try {
        await waitFor(() => inventory && observations.length > 0)
        fixture.update()
        await waitFor(() =>
          observations.some((value) => value.materialsObservation),
        )
        const material = observations.find(
          (value) => value.materialsObservation,
        )?.materialsObservation
        assert.deepEqual(material?.materials, [
          {
            slot: 'external',
            active: true,
            materialType: 'PLA',
            colorHex: 'AABBCCFF',
            remainingPercent: 50,
          },
        ])
        const reads = fixture.requests.filter(
          (request) => request.path === '/server/spoolman/spool_id',
        )
        assert.ok(reads.length > 0)
        for (const request of reads) {
          assert.equal(request.key, auth === 'key' ? 'test-key' : undefined)
          assert.equal(
            request.authorization,
            auth === 'jwt' ? `Bearer ${fixture.token}` : undefined,
          )
        }
        fixture.reply({ result: { spool_id: '42' } })
        const before = observations.length
        fixture.update()
        await waitFor(
          () =>
            observations.length > before &&
            fixture.requests.filter(
              (r) => r.path === '/server/spoolman/spool_id',
            ).length > reads.length,
        )
        assert.deepEqual(observations[before]?.materialsObservation, material)
        await new Promise((resolve) => setTimeout(resolve, 50))
        assert.equal(
          observations.at(-1)?.materialsObservation?.observedAtMonoMs,
          material?.observedAtMonoMs,
        )
        offset += 5001
        const after = observations.length
        fixture.update()
        await waitFor(() => observations.length > after)
        assert.equal(observations[after]?.materialsObservation, undefined)
        await new Promise((resolve) => setTimeout(resolve, 50))
        assert.equal(observations.at(-1)?.materialsObservation, undefined)
        assert.ok(
          fixture.requests.some((request) => request.path === '/api/v1/spool'),
        )
      } finally {
        controller.abort()
        await done
        queue.close()
        await fixture.close()
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )
}
