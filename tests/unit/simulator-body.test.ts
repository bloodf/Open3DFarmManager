import { expect, test } from 'bun:test'
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
