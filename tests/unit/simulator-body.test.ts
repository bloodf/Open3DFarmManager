import { expect, test } from 'vitest'
import { readJson } from '../../packages/sim-tools/src/body.ts'

const prefix = new TextEncoder().encode('{"label":"')
const suffix = new TextEncoder().encode('"}')

test.each([
  { invalid: [0xff] },
  { invalid: [0xc3] },
  { invalid: [0xe2, 0x28, 0xa1] },
])(
  'rejects malformed UTF-8 inside otherwise valid JSON: %j',
  async ({ invalid }) => {
    const body = new Uint8Array([...prefix, ...invalid, ...suffix])
    await expect(readJson(new Response(body))).rejects.toThrow()
  },
)

test('preserves a valid multibyte character split across response chunks', async () => {
  const bytes = new TextEncoder().encode('{"label":"bobina azul – 3D"}')
  const response = new Response(
    new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
        controller.close()
      },
    }),
  )
  expect(await readJson(response)).toEqual({ label: 'bobina azul – 3D' })
})

test.each([
  '{"state":"shutdown","state":"ready"}',
  '{"result":{"id":1,"id":2}}',
  '{"result":{"id":1,"\\u0069d":2}}',
])('rejects ambiguous duplicate keys: %s', async (body) => {
  await expect(readJson(new Response(body))).rejects.toThrow('duplicate-key')
})

test('allows the same field name in distinct response objects', async () => {
  const body = '[{"id":1},{"id":2}]'
  expect(await readJson(new Response(body))).toEqual([{ id: 1 }, { id: 2 }])
})

test('rejects excessive response nesting before decoding values', async () => {
  const body = '['.repeat(33) + '0' + ']'.repeat(33)
  await expect(readJson(new Response(body))).rejects.toThrow('depth-limit')
})

test('enforces the response value budget independently of byte size', async () => {
  const body = JSON.stringify(new Array(32_768).fill(0))
  expect(new TextEncoder().encode(body).byteLength).toBeLessThan(256 * 1024)
  await expect(readJson(new Response(body))).rejects.toThrow('value-limit')
})
