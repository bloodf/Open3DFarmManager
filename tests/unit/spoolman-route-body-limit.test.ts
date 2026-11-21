import { expect, test } from 'vitest'
import { readAuthenticatedBody } from '../../apps/farm/server/routes/spoolman/body.ts'

const oversized = 10 * 1024 * 1024 + 32

test('rejects unauthenticated chunked input before consuming its body', async () => {
  let consumed = 0
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        consumed += 1024
        controller.enqueue(new Uint8Array(1024))
      },
    },
    { highWaterMark: 0 },
  )
  const result = await readAuthenticatedBody(stream, async () => false)
  expect(result.status).toBe(401)
  expect(consumed).toBe(0)
})

test('bounds authenticated chunked input and accepts a body below the limit', async () => {
  let consumed = 0
  const tooLarge = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (consumed >= oversized) return controller.close()
      const length = Math.min(1024, oversized - consumed)
      consumed += length
      controller.enqueue(new Uint8Array(length))
    },
  })
  expect((await readAuthenticatedBody(tooLarge, async () => true)).status).toBe(
    413,
  )
  expect(consumed).toBeLessThanOrEqual(10 * 1024 * 1024 + 1024)

  const valid = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"ok":true}'))
      controller.close()
    },
  })
  expect(await readAuthenticatedBody(valid, async () => true)).toEqual({
    status: 200,
    body: '{"ok":true}',
  })
})
