const MAX_BODY_BYTES = 10 * 1024 * 1024
const BODY_READ_TIMEOUT_MS = 10_000
const MAX_CONCURRENT_BODY_READS = 8
let activeReads = 0
const waiting: (() => void)[] = []

async function acquireReadSlot() {
  if (activeReads >= MAX_CONCURRENT_BODY_READS)
    await new Promise<void>((resolve) => waiting.push(resolve))
  activeReads++
  return () => {
    activeReads--
    waiting.shift()?.()
  }
}

export async function readAuthenticatedBody(
  request: ReadableStream<Uint8Array> | null,
  authenticate: () => Promise<boolean>,
): Promise<{ status: 200 | 401 | 413 | 408; body?: string }> {
  if (!(await authenticate())) return { status: 401 }
  if (!request) return { status: 200, body: '' }
  const release = await acquireReadSlot()
  const reader = request.getReader()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    void reader.cancel()
  }, BODY_READ_TIMEOUT_MS)
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        if (timedOut) return { status: 408 }
        break
      }
      bytes += value.byteLength
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel()
        return { status: 413 }
      }
      chunks.push(value)
    }
    return { status: 200, body: Buffer.concat(chunks).toString('utf8') }
  } catch {
    return { status: 408 }
  } finally {
    clearTimeout(timer)
    release()
  }
}
