import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectIntoQueue } from '../../packages/connector/src/runtime/collect.ts'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { moonrakerSpoolmanFixture } from '../../packages/connector/test/moonraker-spoolman-fixture.ts'
import type { RawPrinterObservation } from '../../packages/connector/src/runtime/farm-snapshot-provider.ts'

test(
  'disconnect clears offline materials without publishing a fresh online row',
  { timeout: 10000 },
  async (t) => {
    const fixture = await moonrakerSpoolmanFixture()
    const dir = mkdtempSync(join(tmpdir(), 'active-spool-disconnect-'))
    const queue = new TelemetryQueue(join(dir, 'queue'), Date.now())
    const controller = new AbortController()
    const realSetTimeout = setTimeout
    // Drive status through the fixture and leave periodic queries paused.
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let invalidationRowCount: number | undefined
    let inventoryReady = false
    let before: number | undefined
    let readsBefore: number | undefined
    const reads = () =>
      fixture.requests.filter(
        (request) => request.path === '/server/spoolman/spool_id',
      ).length
    const states = () =>
      queue
        .batch(Date.now())
        .records.filter((record) => record.kind === 'printer-state')
        .map((record) => record.state)
    const done = collectIntoQueue({
      config: {
        version: 1,
        allowedOrigins: [fixture.origin],
        printers: [{ printerKey: 'printer', origin: fixture.origin }],
        limits: {
          maxMessageBytes: 4096,
          connectTimeoutMs: 1000,
          requestTimeoutMs: 1000,
          staleAfterMs: 30000,
          reconnectMinMs: 5000,
          reconnectMaxMs: 5000,
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
        inventoryReady = value.kind === 'observed'
      },
      onRawObservation(value) {
        if (
          before !== undefined ||
          value.materialsObservation?.materials[0]?.materialType !== 'PLA'
        )
          return
        // The material read queues its state before notifying observers.
        before = states().length
        readsBefore = reads()
        fixture.disconnect()
      },
      onRawUnavailable() {
        invalidationRowCount = states().length
      },
    })
    async function waitFor(predicate: () => boolean) {
      const deadline = Date.now() + 4000
      while (!predicate()) {
        if (Date.now() > deadline)
          throw Error('Timed out waiting for collection')
        // Let Spoolman's zero-delay initial inventory read start.
        t.mock.timers.tick(0)
        await new Promise((resolve) => realSetTimeout(resolve, 10))
      }
    }
    try {
      await waitFor(() => inventoryReady && states().length > 0)
      if (before === undefined) fixture.update()
      await waitFor(() => states().at(-1)?.state === 'offline')
      assert.ok(before !== undefined && before > 0)
      assert.equal(invalidationRowCount, before)
      assert.deepEqual(
        states()
          .slice(before)
          .map((state) => state.state),
        ['offline'],
      )
      assert.equal(states().at(before - 1)?.materials?.[0]?.materialType, 'PLA')
      assert.equal(states().at(-1)?.materials, undefined)
      assert.equal(reads(), readsBefore)
    } finally {
      controller.abort()
      await done
      queue.close()
      await fixture.close()
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

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
          // Install failure at publication, before another read can refresh
          // the timestamp that the assertions below deliberately latch.
          if (value.materialsObservation)
            fixture.reply({ result: { spool_id: '42' } })
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
        // Begin the next status update with a completed valid material read,
        // then wait until its spool-id request has reached the fixture.
        await waitFor(() =>
          observations.some((value) => value.materialsObservation),
        )
        const initialReads = fixture.requests.filter(
          (request) => request.path === '/server/spoolman/spool_id',
        ).length
        fixture.update()
        await waitFor(
          () =>
            fixture.requests.filter(
              (request) => request.path === '/server/spoolman/spool_id',
            ).length > initialReads,
        )
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

test(
  'fresh active spool evidence reaches durable state and superseded evidence does not',
  { timeout: 10000 },
  async (t) => {
    const fixture = await moonrakerSpoolmanFixture()
    const dir = mkdtempSync(join(tmpdir(), 'active-spool-telemetry-'))
    const queue = new TelemetryQueue(join(dir, 'queue'), Date.now())
    const controller = new AbortController()
    const observations: RawPrinterObservation[] = []
    let inventoryKind: string | undefined
    let offset = 0
    const realNow = performance.now.bind(performance)
    t.mock.method(performance, 'now', () => realNow() + offset)
    fixture.reply({ result: { spool_id: null } })
    const done = collectIntoQueue({
      config: {
        version: 1,
        allowedOrigins: [fixture.origin],
        printers: [{ printerKey: 'printer', origin: fixture.origin }],
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
        inventoryKind = value.kind
      },
      onRawObservation(value) {
        observations.push(value)
      },
    })
    const states = () =>
      queue
        .batch(Date.now())
        .records.filter((record) => record.kind === 'printer-state')
        .map((record) => record.state)
    const reads = () =>
      fixture.requests.filter(
        (request) => request.path === '/server/spoolman/spool_id',
      ).length
    async function waitFor(predicate: () => boolean) {
      const deadline = Date.now() + 4000
      while (!predicate()) {
        if (Date.now() > deadline)
          throw Error('Timed out waiting for collection')
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    try {
      await waitFor(() => states().length > 0 && reads() > 0)
      assert.equal(states().at(-1)?.materials, undefined)
      fixture.reply({ result: { spool_id: 42 } })
      let before = reads()
      fixture.update()
      await waitFor(
        () =>
          reads() > before &&
          states().at(-1)?.materials?.[0]?.materialType === 'PLA',
      )
      assert.deepEqual(
        states().at(-1)?.materials,
        observations.at(-1)?.materialsObservation?.materials,
      )
      fixture.reply({ result: { spool_id: 43 } })
      before = reads()
      fixture.update()
      await waitFor(
        () =>
          reads() > before &&
          states().at(-1)?.materials?.[0]?.materialType === 'PETG',
      )
      assert.deepEqual(
        states().at(-1)?.materials,
        observations.at(-1)?.materialsObservation?.materials,
      )

      // A response which took longer than the freshness window must not replace
      // the current material, even if a later status update arrives meanwhile.
      fixture.reply({ result: { spool_id: 42 } })
      fixture.holdNext()
      before = reads()
      fixture.update()
      await waitFor(() => reads() > before)
      offset += 5001
      fixture.update()
      await waitFor(() => states().at(-1)?.materials === undefined)
      fixture.release()
      await new Promise((resolve) => setTimeout(resolve, 50))
      assert.equal(states().at(-1)?.materials, undefined)
      assert.equal(observations.at(-1)?.materialsObservation, undefined)

      // A pending response belongs to the inventory snapshot that started it.
      // Invalidating that snapshot supersedes the response even when it is fast.
      fixture.reply({ result: { spool_id: 43 } })
      before = reads()
      fixture.update()
      await waitFor(
        () =>
          reads() > before &&
          states().at(-1)?.materials?.[0]?.materialType === 'PETG',
      )
      fixture.reply({ result: { spool_id: 42 } })
      fixture.holdNext()
      before = reads()
      fixture.update()
      await waitFor(() => reads() > before)
      fixture.invalidateInventory()
      await waitFor(() => inventoryKind === 'stale')
      fixture.release()
      await new Promise((resolve) => setTimeout(resolve, 50))
      assert.equal(states().at(-1)?.materials?.[0]?.materialType, 'PETG')
      assert.notEqual(
        observations.at(-1)?.materialsObservation?.materials[0]?.materialType,
        'PLA',
      )
    } finally {
      fixture.release()
      controller.abort()
      await done
      queue.close()
      await fixture.close()
      rmSync(dir, { recursive: true, force: true })
    }
  },
)
