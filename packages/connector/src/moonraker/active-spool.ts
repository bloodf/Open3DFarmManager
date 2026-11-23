/**
 * Parse Moonraker `GET /server/spoolman/spool_id` JSON.
 * Only numeric `spool_id` values are accepted (Moonraker's wire type).
 * @see https://moonraker.readthedocs.io/en/latest/external_api/spoolman/
 */
export function parseMoonrakerActiveSpoolId(body: unknown): number | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    return null
  const result = Reflect.get(body, 'result')
  if (result === null || typeof result !== 'object' || Array.isArray(result))
    return null
  const spoolId = Reflect.get(result, 'spool_id')
  if (
    typeof spoolId === 'number' &&
    Number.isSafeInteger(spoolId) &&
    spoolId > 0
  )
    return spoolId
  return null
}

/** Moonraker answered that it has no Spoolman component configured. */
export class MoonrakerSpoolmanAbsent extends Error {}

/**
 * One read-only `GET /server/spoolman/spool_id` with a bounded body.
 * Resolves the active spool id or null (Moonraker tracks no spool); rejects
 * with {@link MoonrakerSpoolmanAbsent} on 404 (no `[spoolman]` component) and
 * with a plain error for anything uncertain, so callers never guess.
 */
export async function readMoonrakerActiveSpoolId(input: {
  origin: string
  headers?: Record<string, string>
  timeoutMs: number
  signal: AbortSignal
  fetch?: typeof fetch
}): Promise<number | null> {
  const response = await (input.fetch ?? fetch)(
    new URL('/server/spoolman/spool_id', input.origin),
    {
      headers: input.headers ?? {},
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.any([
        input.signal,
        AbortSignal.timeout(input.timeoutMs),
      ]),
    },
  )
  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined)
    throw new MoonrakerSpoolmanAbsent('Moonraker Spoolman component absent')
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error('Moonraker active spool unavailable')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.length
      if (size > 4096) throw new Error('Moonraker active spool bound')
      chunks.push(chunk.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  const result =
    body && typeof body === 'object' ? Reflect.get(body, 'result') : undefined
  if (
    !result ||
    typeof result !== 'object' ||
    !Object.hasOwn(result, 'spool_id')
  )
    throw new Error('Invalid Moonraker active spool')
  return parseMoonrakerActiveSpoolId(body)
}
