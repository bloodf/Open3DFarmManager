import { createBoundedSpoolmanReader } from './bounded-read.ts'
import {
  parseSpoolmanSpoolInventory,
  type SpoolmanInventoryContext,
} from './read.ts'

/** Synthetic/local prototype only: no discovery, credentials or production authorization. */
export function createLoopbackSpoolmanReader(options: {
  origin: string
  context: SpoolmanInventoryContext
  timeoutMs: number
}) {
  let origin: string
  const context = { ...options.context }
  const timeoutMs = options.timeoutMs
  try {
    const url = new URL(options.origin)
    if (
      !['127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.protocol !== 'http:' ||
      ![url.origin, `${url.origin}/`].includes(options.origin) ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 60_000
    )
      throw new Error()
    origin = url.origin
    parseSpoolmanSpoolInventory(
      [{ offset: 0, observedAt: 0, wire: '[]' }],
      context,
    )
  } catch {
    throw new Error('Invalid local Spoolman configuration')
  }
  return createBoundedSpoolmanReader({ origin, context, timeoutMs })
}
