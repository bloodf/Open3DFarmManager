import {
  CHUNK_SIZE,
  parseOffer,
} from '../../../../../packages/farm-protocol/src/file-transfer.ts'
export interface TransferChannel {
  bufferedAmount: number
  send(message: unknown): Promise<unknown>
}
export async function sendFile(
  channel: TransferChannel,
  offer: unknown,
  file: Blob,
  signal?: AbortSignal,
) {
  const parsed = parseOffer(offer)
  if (file.size !== parsed.size) throw new Error('size')
  if ((await channel.send(parsed)) !== 'accept') throw new Error('rejected')
  try {
    let seq = 0
    for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
      while (channel.bufferedAmount > CHUNK_SIZE * 4) {
        signal?.throwIfAborted()
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      signal?.throwIfAborted()
      const bytes = new Uint8Array(
        await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer(),
      )
      await channel.send({ type: 'chunk', seq: seq++, bytes })
    }
    await channel.send({ type: 'complete' })
  } catch (error) {
    await channel.send({ type: 'abort' })
    throw error
  }
}
