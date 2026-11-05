import { parseBoundedJson } from '@open3dfarmmanager/farm-protocol'

export async function readBytes(
  response: Response,
  limit: number,
): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Empty simulator response')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel()
        throw new Error('Simulator response exceeds size limit')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
export async function readJson(response: Response): Promise<unknown> {
  return parseBoundedJson(
    new TextDecoder('utf-8', { fatal: true }).decode(
      await readBytes(response, 256 * 1024),
    ),
    {
      maxBytes: 256 * 1024,
      maxDepth: 32,
      maxValues: 32_768,
      maxStringChars: 65_536,
    },
  )
}
