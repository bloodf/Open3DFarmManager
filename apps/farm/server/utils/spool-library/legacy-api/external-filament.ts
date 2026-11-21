/** External filament catalog for the pinned Spoolman v0.27.1 API.
 * The caller owns refresh scheduling and the catalog instance; no request
 * credentials are accepted by the catalog or forwarded to its source.
 */
import { createHash } from 'node:crypto'
import { asInt, type Issue, unprocessable } from './validation.ts'
import { lastQueryValue, respond, type LegacyApiModule } from './types.ts'

type Filament = {
  id: string
  manufacturer: string
  name: string
  material: string
  density: number
  weight: number
  diameter: number
  spool_weight: number | null
  spool_type: string | null
  color_hex: string | null
  color_hexes: string[] | null
  extruder_temp: number | null
  bed_temp: number | null
  finish: string | null
  multi_color_direction: string | null
  pattern: string | null
  translucent: boolean
  glow: boolean
}
type CacheEntry = {
  body: unknown
  etag: string | null
  modified: string | null
  expires: number
}
type Snapshot = {
  items: Filament[]
  modified: Date
  etag: string
  size: number
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid catalog entry')
  return Object.fromEntries(Object.entries(value))
}
function parseFilament(input: unknown): Filament {
  const obj = record(input)
  const str = (key: string): string => {
    const value = obj[key]
    if (typeof value !== 'string') throw new Error(`Invalid ${key}`)
    return value
  }
  const number = (key: string): number => {
    const value = obj[key]
    const parsed =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim()
          ? Number(value)
          : NaN
    if (!Number.isFinite(parsed)) throw new Error(`Invalid ${key}`)
    return parsed
  }
  const optional = <T>(key: string, parse: (key: string) => T): T | null =>
    obj[key] == null ? null : parse(key)
  const choice = (key: string, values: string[]) =>
    optional(key, (name) => {
      const value = str(name)
      if (!values.includes(value)) throw new Error(`Invalid ${name}`)
      return value
    })
  const bool = (key: string) => {
    const value = obj[key] === undefined ? false : obj[key]
    if (typeof value === 'boolean') return value
    if (value === 0 || value === 1) return Boolean(value)
    if (typeof value === 'string') {
      if (['0', 'off', 'f', 'false', 'n', 'no'].includes(value.toLowerCase()))
        return false
      if (['1', 'on', 't', 'true', 'y', 'yes'].includes(value.toLowerCase()))
        return true
    }
    throw new Error(`Invalid ${key}`)
  }
  const colors = optional('color_hexes', (key) => {
    const value = obj[key]
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string'))
      throw new Error(`Invalid ${key}`)
    return value.filter((v): v is string => typeof v === 'string')
  })
  const integer = (key: string) => {
    const value = number(key)
    if (!Number.isInteger(value)) throw new Error(`Invalid ${key}`)
    return value
  }
  return {
    id: str('id'),
    manufacturer: str('manufacturer'),
    name: str('name'),
    material: str('material'),
    density: number('density'),
    weight: number('weight'),
    spool_weight: optional('spool_weight', number),
    spool_type: choice('spool_type', ['plastic', 'cardboard', 'metal']),
    diameter: number('diameter'),
    color_hex: optional('color_hex', str),
    color_hexes: colors,
    extruder_temp: optional('extruder_temp', integer),
    bed_temp: optional('bed_temp', integer),
    finish: choice('finish', ['matte', 'glossy']),
    multi_color_direction: choice('multi_color_direction', [
      'coaxial',
      'longitudinal',
    ]),
    pattern: choice('pattern', ['marble', 'sparkle']),
    translucent: bool('translucent'),
    glow: bool('glow'),
  }
}
function parseList(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Invalid catalog')
  return value
}

/** Explicit sync, matching upstream's scheduled, atomic catalog replacement. */
export function createExternalFilamentCatalog(
  baseUrl: string,
  fetcher: typeof fetch = fetch,
) {
  let snapshot: Snapshot | undefined
  const cache = new Map<string, CacheEntry>()
  async function download(file: string): Promise<unknown> {
    const url = new URL(file, baseUrl).href
    const cached = cache.get(url)
    const now = Date.now()
    if (cached && cached.expires > now) return cached.body
    const headers: Record<string, string> = {}
    if (cached?.etag) headers['if-none-match'] = cached.etag
    if (cached?.modified) headers['if-modified-since'] = cached.modified
    let response: Response
    try {
      response = await fetcher(url, { headers, redirect: 'error' })
    } catch (error) {
      if (cached) return cached.body
      throw error
    }
    if (response.status === 304 && cached) {
      const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(
        response.headers.get('cache-control') ?? '',
      )
      cached.expires = now + (maxAge ? Number(maxAge[1]) * 1000 : 0)
      return cached.body
    }
    if (!response.ok) {
      if (cached && response.status >= 500) return cached.body
      throw new Error(`External catalog HTTP ${response.status}`)
    }
    const body: unknown = await response.json()
    const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(
      response.headers.get('cache-control') ?? '',
    )
    const control = response.headers.get('cache-control') ?? ''
    if (/\bno-store\b/i.test(control)) cache.delete(url)
    else
      cache.set(url, {
        body,
        etag: response.headers.get('etag'),
        modified: response.headers.get('last-modified'),
        expires:
          now +
          (!/\bno-cache\b/i.test(control) && maxAge
            ? Number(maxAge[1]) * 1000
            : 0),
      })
    return body
  }
  return {
    async refresh(): Promise<void> {
      const items = parseList(await download('filaments.json')).map(
        parseFilament,
      )
      // Upstream only publishes the filament file after both source files validate.
      for (const value of parseList(await download('materials.json'))) {
        const obj = record(value)
        if (
          typeof obj.material !== 'string' ||
          obj.density == null ||
          !Number.isFinite(Number(obj.density))
        )
          throw new Error('Invalid material')
      }
      const content = JSON.stringify(items)
      const modified = new Date()
      const size = Buffer.byteLength(content)
      const etag = `"${createHash('md5')
        .update(`${modified.getTime() / 1000}-${size}`)
        .digest('hex')}"`
      snapshot = { items, modified, etag, size }
    },
    get snapshot() {
      return snapshot
    },
  }
}

export function createExternalFilamentModule(
  catalog: ReturnType<typeof createExternalFilamentCatalog>,
): LegacyApiModule {
  return {
    name: 'external-filament',
    async handle(_repository, request) {
      const path = request.apiPath
      if (
        path !== '/api/v1/external/filament' &&
        path !== '/api/v1/external/filament/search'
      )
        return undefined
      if (request.method !== 'GET')
        return respond(405, { detail: 'Method Not Allowed' }, { allow: 'GET' })
      const snapshot = catalog.snapshot
      if (path.endsWith('/filament')) {
        if (!snapshot) return respond(500, 'Internal Server Error')
        // The request contract has no incoming headers. These metadata headers
        // mirror FileResponse; Range and If-Range processing require #545 to
        // extend that contract before this module can support them.
        return respond(200, snapshot.items, {
          'content-type': 'application/json',
          'content-length': String(snapshot.size),
          'last-modified': snapshot.modified.toUTCString(),
          etag: snapshot.etag,
          'accept-ranges': 'bytes',
        })
      }
      const issues: Issue[] = []
      const query = lastQueryValue(request.query, 'query')
      if (query === null)
        issues.push({
          type: 'missing',
          loc: ['query', 'query'],
          msg: 'Field required',
          input: null,
        })
      const readInt = (
        key: string,
        fallback: number,
        min: number,
        max?: number,
      ) => {
        const raw = lastQueryValue(request.query, key)
        if (raw === null) return fallback
        const parsed = asInt(['query', key], raw)
        if (!parsed.ok) {
          issues.push(parsed.issue)
          return fallback
        }
        const n = parsed.value
        if (n < min)
          issues.push({
            type: 'greater_than_equal',
            loc: ['query', key],
            msg: `Input should be greater than or equal to ${min}`,
            input: raw,
            ctx: { ge: min },
          })
        else if (max !== undefined && n > max)
          issues.push({
            type: 'less_than_equal',
            loc: ['query', key],
            msg: `Input should be less than or equal to ${max}`,
            input: raw,
            ctx: { le: max },
          })
        return n
      }
      const limit = readInt('limit', 20, 1, 100),
        offset = readInt('offset', 0, 0)
      if (issues.length) return unprocessable(issues)
      const words = (query ?? '')
        .toLowerCase()
        .trim()
        .split(/\s+/u)
        .filter(Boolean)
      const matches = words.length
        ? (snapshot?.items ?? []).filter((item) => {
            const text =
              `${item.manufacturer} ${item.name} ${item.material}`.toLowerCase()
            return words.every((word) => text.includes(word))
          })
        : []
      const page = matches
        .slice(offset, offset + limit)
        .map((item) =>
          Object.fromEntries(
            Object.entries(item).filter(([, value]) => value !== null),
          ),
        )
      return respond(200, page, { 'x-total-count': String(matches.length) })
    },
  }
}
