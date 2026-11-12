import { z } from 'zod'
import { parseBoundedJson } from '@open3dfarmmanager/farm-protocol'

/** JSON-RPC success reply envelope shared by every Moonraker WebSocket client. */
export const Reply = z.strictObject({
  jsonrpc: z.literal('2.0'),
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  result: z.unknown(),
})

/** Decode one text frame with the shared size/structure bounds. Throws on any violation. */
export function decodeMoonrakerFrame(
  data: import('ws').RawData,
  isBinary: boolean,
  maxMessageBytes: number,
): unknown {
  if (isBinary || !Buffer.isBuffer(data) || data.byteLength > maxMessageBytes)
    throw new Error('Invalid frame')
  return parseBoundedJson(data.toString('utf8'), {
    maxBytes: maxMessageBytes,
    maxDepth: 16,
    maxValues: 8192,
    maxStringChars: 16384,
  })
}
