import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { FileReceiver } from '../../packages/connector/src/files/file-transfer.ts'
import {
  parseOffer,
  MAX_FILE_SIZE,
} from '../../packages/farm-protocol/src/file-transfer.ts'
import { sendFile } from '../../apps/farm/app/utils/webrtc/file-transfer.ts'
const bytes = new TextEncoder().encode('G28\n')
const offer = {
  type: 'offer',
  transfer_id: 'test',
  name: 'test.gcode',
  size: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  printer_key: 'printer',
}
test('happy path streams through loopback and removes after forward', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'transfer-'))
  try {
    const receiver = new FileReceiver(dir)
    let session: Awaited<ReturnType<FileReceiver['offer']>>
    let staged: Awaited<ReturnType<typeof session.complete>>
    await sendFile(
      {
        bufferedAmount: 0,
        async send(message) {
          const m = message as Record<string, unknown>
          if (m.type === 'offer') {
            session = await receiver.offer(m)
            return 'accept'
          }
          if (m.type === 'chunk')
            await session.chunk(m.seq as number, m.bytes as Uint8Array)
          if (m.type === 'complete') staged = await session.complete()
        },
      },
      offer,
      new Blob([bytes]),
    )
    await staged!.forward(async (path) =>
      assert.deepEqual(await readFile(path), Buffer.from(bytes)),
    )
    assert.deepEqual(await readdir(dir), [])
  } finally {
    await rm(dir, { recursive: true })
  }
})
test('rejects oversized and unsafe names', () => {
  assert.throws(() => parseOffer({ ...offer, size: MAX_FILE_SIZE + 1 }))
  assert.throws(() => parseOffer({ ...offer, name: '../test.gcode' }))
})
test('sha mismatch and abort clean staging', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'transfer-'))
  try {
    const receiver = new FileReceiver(dir)
    const session = await receiver.offer({ ...offer, sha256: '0'.repeat(64) })
    await session.chunk(0, bytes)
    await assert.rejects(session.complete(), /integrity/)
    await (await receiver.offer(offer)).abort()
    assert.deepEqual(await readdir(dir), [])
  } finally {
    await rm(dir, { recursive: true })
  }
})
test('idle timeout removes staging', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'transfer-'))
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const session = await new FileReceiver(dir).offer(offer)
    t.mock.timers.tick(60_000)
    await assert.rejects(session.chunk(0, bytes), /closed/)
    t.mock.timers.reset()
    for (let n = 0; n < 50 && (await readdir(dir)).length; n++)
      await new Promise((resolve) => setTimeout(resolve, 5))
    assert.deepEqual(await readdir(dir), [])
  } finally {
    t.mock.timers.reset()
    await rm(dir, { recursive: true })
  }
})
test('backpressure waits before reading and sending chunks', async () => {
  let buffered = 100_000
  let reads = 0
  const messages: string[] = []
  const file = new Blob([bytes])
  const originalSlice = file.slice.bind(file)
  file.slice = ((...args: Parameters<Blob['slice']>) => {
    const chunk = originalSlice(...args)
    const read = chunk.arrayBuffer.bind(chunk)
    return Object.assign(chunk, {
      async arrayBuffer() {
        reads++
        return read()
      },
    })
  }) as Blob['slice']
  const run = sendFile(
    {
      get bufferedAmount() {
        return buffered
      },
      async send(message) {
        const type = (message as { type: string }).type
        messages.push(type)
        return type === 'offer' ? 'accept' : undefined
      },
    },
    offer,
    file,
  )
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(messages, ['offer'])
  assert.equal(
    reads,
    0,
    'chunk bytes must not be read while the channel is full',
  )
  buffered = 0
  await run
  assert.equal(reads, 1)
  assert.deepEqual(messages, ['offer', 'chunk', 'complete'])
})
