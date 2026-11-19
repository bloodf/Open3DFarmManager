import {
  moonrakerAuthHeaders,
  moonrakerSession,
  type MoonrakerLimits,
} from '../config/moonraker.ts'

/** Bounded read of `configfile.settings`; the result shape matches `printer.objects.query`. */
export async function fetchMoonrakerConfigfile(input: {
  origin: string
  limits: MoonrakerLimits
  signal: AbortSignal
}): Promise<unknown> {
  const session = moonrakerSession(input.origin, input.limits)
  const headers = session
    ? await session.getAuthHeaders()
    : moonrakerAuthHeaders(input.origin, input.limits)
  const response = await fetch(
    new URL('/printer/objects/query?configfile=settings', input.origin),
    {
      headers,
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.any([
        input.signal,
        AbortSignal.timeout(Math.min(5000, input.limits.requestTimeoutMs)),
      ]),
    },
  )
  if (!response.ok || !response.body) throw Error('Machine profile unavailable')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.length
      if (size > input.limits.maxMessageBytes)
        throw Error('Machine profile response bound')
      chunks.push(chunk.value)
    }
  } finally {
    await reader.cancel()
  }
  return JSON.parse(Buffer.concat(chunks).toString()).result
}
