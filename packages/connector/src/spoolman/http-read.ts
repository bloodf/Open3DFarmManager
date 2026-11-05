import {
  parseSpoolmanSpools,
  parseSpoolmanSpoolInventory,
  type SpoolmanInventoryContext,
  type SpoolmanInventoryPage,
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
  return async (signal?: AbortSignal) => {
    const controller = new AbortController()
    const combined = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal
    const started = performance.now()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const check = () => {
      if (combined.aborted || performance.now() - started >= timeoutMs)
        throw new Error()
    }
    const pages: SpoolmanInventoryPage[] = []
    let lastId = 0
    let itemCount = 0
    let totalBytes = 0
    let offset: number | null = 0
    try {
      while (offset !== null) {
        check()
        if (pages.length >= 256) throw new Error()
        const url = new URL('/api/v1/spool', origin)
        url.search = new URLSearchParams({
          limit: String(context.limit),
          offset: String(offset),
          sort: 'id:asc',
          allow_archived: 'true',
        }).toString()
        const response = await fetch(url, {
          method: 'GET',
          signal: combined,
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          headers: { accept: 'application/json' },
        })
        check()
        if (
          response.status !== 200 ||
          response.headers
            .get('content-type')
            ?.split(';')[0]
            ?.trim()
            .toLowerCase() !== 'application/json' ||
          !response.body
        )
          throw new Error()
        const length = response.headers.get('content-length')
        if (
          length !== null &&
          (!/^\d+$/.test(length) || Number(length) > 256 * 1024)
        )
          throw new Error()
        const reader = response.body.getReader()
        const chunks: Uint8Array[] = []
        let bytes = 0
        try {
          while (true) {
            check()
            const chunk = await reader.read()
            check()
            if (chunk.done) break
            bytes += chunk.value.byteLength
            totalBytes += chunk.value.byteLength
            if (bytes > 256 * 1024 || totalBytes > 4 * 1024 * 1024)
              throw new Error()
            chunks.push(chunk.value)
          }
        } finally {
          // Abort closes failed or incomplete response streams without awaiting an untrusted body.
          reader.releaseLock()
        }
        const wire = new TextDecoder('utf-8', { fatal: true }).decode(
          Buffer.concat(chunks),
        )
        const observedAt = Date.now()
        const page = parseSpoolmanSpools(wire, {
          ...context,
          offset,
          observedAt,
        })
        for (const item of page.items) {
          if (item.id <= lastId || itemCount >= 10_000) throw new Error()
          lastId = item.id
          itemCount++
        }
        pages.push({ wire, offset, observedAt })
        offset = page.nextOffset
      }
      const inventory = parseSpoolmanSpoolInventory(pages, context)
      check()
      return inventory
    } catch {
      // Do not expose URLs, remote bodies, caller abort reasons or partial inventories.
      throw new Error('Local Spoolman read failed')
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }
}
