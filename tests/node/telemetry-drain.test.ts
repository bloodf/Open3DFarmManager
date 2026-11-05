import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TelemetryQueue,
  type TelemetryRecord,
} from '../../packages/connector/src/cloud/queue.ts'
import { drainTelemetryOnce } from '../../packages/connector/src/cloud/drain.ts'
import { parseMoonrakerSnapshot } from '../../packages/connector/src/moonraker/parse.ts'
const raw = readFileSync(
  new URL('../fixtures/moonraker/printing.json', import.meta.url),
  'utf8',
)
const state = parseMoonrakerSnapshot(raw, {
  printerKey: 'synthetic',
  observedAt: 1000,
}).printer
const ids = (body: string) =>
  (JSON.parse(body) as TelemetryRecord[]).map((row) => row.eventId)
const signal = () => new AbortController().signal
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'open3d-drain-'))
  const queue = new TelemetryQueue(directory, 1000)
  return {
    directory,
    queue,
    cleanup: () => {
      queue.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

test('synthetic Moonraker state survives outage and restart, then drains to an idempotent sink', async () => {
  const f = fixture()
  let reopened: TelemetryQueue | undefined
  try {
    const eventId = f.queue.enqueue(state, 1000).eventId
    const received = new Set<string>()
    let firstBody = ''
    const failed = await drainTelemetryOnce(
      f.queue,
      async (body) => {
        firstBody = body
        ids(body).forEach((id) => received.add(id))
        throw new Error('synthetic response lost after acceptance')
      },
      () => 1000,
      signal(),
    )
    assert.equal(failed.status, 'retained')
    assert.equal(f.queue.depth, 1)
    f.queue.close()
    reopened = new TelemetryQueue(f.directory, 1001)
    const delivered = await drainTelemetryOnce(
      reopened,
      async (body) => {
        assert.equal(body, firstBody)
        ids(body).forEach((id) => received.add(id))
        return ids(body)
      },
      () => 1001,
      signal(),
    )
    assert.equal(delivered.status, 'delivered')
    assert.deepEqual([...received], [eventId])
    assert.equal(reopened.depth, 0)
    reopened.close()
    reopened = new TelemetryQueue(f.directory, 1002)
    assert.equal(reopened.depth, 0)
  } finally {
    reopened?.close()
    f.cleanup()
  }
})
test('empty queue never invokes transport', async () => {
  const f = fixture()
  try {
    const result = await drainTelemetryOnce(
      f.queue,
      async () => {
        throw new Error('must not run')
      },
      () => 1000,
      signal(),
    )
    assert.equal(result.status, 'empty')
  } finally {
    f.cleanup()
  }
})
test('wrong, partial, reordered, duplicate and malformed acknowledgements retain the full batch', async () => {
  const f = fixture()
  try {
    const a = f.queue.enqueue(state, 1000).eventId,
      b = f.queue.enqueue(state, 1000).eventId
    for (const ack of [
      null,
      {},
      [],
      [a],
      [b, a],
      [a, a],
      ['other', b],
      [a, b, 'extra'],
      new Array(2),
    ]) {
      assert.deepEqual(
        (
          await drainTelemetryOnce(
            f.queue,
            async () => ack,
            () => 1000,
            signal(),
          )
        ).status,
        'retained',
      )
      assert.equal(f.queue.depth, 2)
    }
    assert.equal(
      (
        await drainTelemetryOnce(
          f.queue,
          async () => [a, b],
          () => 1000,
          signal(),
        )
      ).status,
      'delivered',
    )
  } finally {
    f.cleanup()
  }
})
test('cancellation retains records and a late success cannot acknowledge them', async () => {
  const f = fixture()
  try {
    const id = f.queue.enqueue(state, 1000).eventId
    const controller = new AbortController()
    let resolve!: (ids: string[]) => void
    let started!: () => void
    const ready = new Promise<void>((r) => {
      started = r
    })
    const attempt = drainTelemetryOnce(
      f.queue,
      async () => {
        started()
        return new Promise<string[]>((r) => {
          resolve = r
        })
      },
      () => 1000,
      controller.signal,
    )
    await ready
    controller.abort()
    assert.equal((await attempt).status, 'retained')
    resolve([id])
    // Let the async sender and its adopted promise finish before starting a retry.
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(f.queue.depth, 1)
    assert.equal(
      (
        await drainTelemetryOnce(
          f.queue,
          async (body) => ids(body),
          () => 1000,
          signal(),
        )
      ).status,
      'delivered',
    )
  } finally {
    f.cleanup()
  }
})
test('overlapping drain attempts do not send a second batch', async () => {
  const f = fixture()
  try {
    f.queue.enqueue(state, 1000)
    let finish!: (value: string[]) => void
    let started!: () => void
    const ready = new Promise<void>((r) => {
      started = r
    })
    let accepted: string[] = []
    const attempt = drainTelemetryOnce(
      f.queue,
      async (body) => {
        accepted = ids(body)
        started()
        return new Promise<string[]>((r) => {
          finish = r
        })
      },
      () => 1000,
      signal(),
    )
    await ready
    assert.deepEqual(
      await drainTelemetryOnce(
        f.queue,
        async () => {
          throw new Error('must not send')
        },
        () => 1000,
        signal(),
      ),
      { status: 'retained', reason: 'busy' },
    )
    finish(accepted)
    assert.equal((await attempt).status, 'delivered')
  } finally {
    f.cleanup()
  }
})
test('enqueue while awaiting acceptance preserves new records after prefix acknowledgement', async () => {
  const f = fixture()
  try {
    const first = f.queue.enqueue(state, 1000).eventId
    let second = ''
    assert.equal(
      (
        await drainTelemetryOnce(
          f.queue,
          async (body) => {
            assert.deepEqual(ids(body), [first])
            second = f.queue.enqueue(state, 1000).eventId
            return ids(body)
          },
          () => 1000,
          signal(),
        )
      ).status,
      'delivered',
    )
    assert.deepEqual(
      f.queue.batch(1000).records.map((row) => row.eventId),
      [second],
    )
  } finally {
    f.cleanup()
  }
})
test('bounded batches drain FIFO without sending commands or oversized bodies', async () => {
  const f = fixture()
  try {
    const expected = Array.from(
      { length: 120 },
      () => f.queue.enqueue(state, 1000).eventId,
    )
    const received: string[] = []
    for (let attempt = 0; f.queue.depth && attempt < 10; attempt++) {
      const result = await drainTelemetryOnce(
        f.queue,
        async (body) => {
          assert.ok(Buffer.byteLength(body) <= 64 * 1024)
          const rows = JSON.parse(body) as TelemetryRecord[]
          assert.ok(rows.length <= 100)
          assert.ok(rows.every((row) => row.kind === 'printer-state'))
          received.push(...ids(body))
          return ids(body)
        },
        () => 1000,
        signal(),
      )
      assert.equal(result.status, 'delivered')
    }
    assert.equal(f.queue.depth, 0)
    assert.deepEqual(received, expected)
  } finally {
    f.cleanup()
  }
})
test('pre-abort and queue failure do not call transport', async () => {
  const f = fixture()
  try {
    f.queue.enqueue(state, 1000)
    const controller = new AbortController()
    controller.abort()
    const never = async () => {
      throw new Error('must not send')
    }
    assert.equal(
      (await drainTelemetryOnce(f.queue, never, () => 1000, controller.signal))
        .status,
      'retained',
    )
    f.queue.close()
    assert.deepEqual(
      await drainTelemetryOnce(f.queue, never, () => 1000, signal()),
      { status: 'uncertain', reason: 'queue' },
    )
  } finally {
    f.cleanup()
  }
})

test('cancellation during batch preparation does not send or create an unhandled rejection', async () => {
  const f = fixture()
  try {
    f.queue.enqueue(state, 1000)
    const controller = new AbortController()
    const result = await drainTelemetryOnce(
      f.queue,
      async () => {
        assert.fail('must not send')
      },
      () => {
        controller.abort()
        return 1000
      },
      controller.signal,
    )
    assert.equal(result.status, 'retained')
    assert.equal(f.queue.depth, 1)
    await new Promise((resolve) => setImmediate(resolve))
  } finally {
    f.cleanup()
  }
})
test('local acknowledgement failure reports uncertainty rather than successful delivery', async () => {
  const f = fixture()
  let recovered: TelemetryQueue | undefined
  try {
    const eventId = f.queue.enqueue(state, 1000).eventId
    const result = await drainTelemetryOnce(
      f.queue,
      async (body) => {
        f.queue.close()
        return ids(body)
      },
      () => 1000,
      signal(),
    )
    assert.equal(result.status, 'uncertain')
    recovered = new TelemetryQueue(f.directory, 1001)
    assert.deepEqual(
      recovered.batch(1001).records.map((row) => row.eventId),
      [eventId],
    )
  } finally {
    recovered?.close()
    f.cleanup()
  }
})

test('cancelled delivery retains the concurrency slot until an abort-ignoring sender settles', async () => {
  const f = fixture()
  try {
    f.queue.enqueue(state, 1000)
    const controller = new AbortController()
    let started!: () => void
    let rejectDelivery!: (error: Error) => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    const attempt = drainTelemetryOnce(
      f.queue,
      async () => {
        started()
        return new Promise<never>((_resolve, reject) => {
          rejectDelivery = reject
        })
      },
      () => 1000,
      controller.signal,
    )
    await ready
    controller.abort()
    assert.equal((await attempt).status, 'retained')
    let secondCalls = 0
    const blocked = await drainTelemetryOnce(
      f.queue,
      async (body) => {
        secondCalls++
        return ids(body)
      },
      () => 1000,
      signal(),
    )
    // Always settle the synthetic sender, even when this regression assertion fails.
    rejectDelivery(new Error('Synthetic late transport failure'))
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(blocked, { status: 'retained', reason: 'busy' })
    assert.equal(secondCalls, 0)
    assert.equal(f.queue.depth, 1)
    assert.equal(
      (
        await drainTelemetryOnce(
          f.queue,
          async (body) => ids(body),
          () => 1000,
          signal(),
        )
      ).status,
      'delivered',
    )
  } finally {
    f.cleanup()
  }
})
