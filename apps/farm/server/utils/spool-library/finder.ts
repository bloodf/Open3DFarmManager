/**
 * Spool finder: reads a scanned spool label and records the shelf it was
 * scanned at in Spoolman's own `location` field. There is no new table; the
 * location is the same value the spool library and the Spoolman API expose.
 *
 * A scan changes a spool at most once. Scanning the same label at the same
 * location again changes nothing, and concurrent scans of one spool are
 * serialised so the second one sees the first one's result. The write is never
 * retried: when its outcome is unknown the scan is reported as `uncertain` and
 * the operator checks the spool before scanning again.
 */
import type {
  Result,
  SpoolLibraryAuthority,
  SpoolLibraryRepository,
  SpoolLibraryStorage,
  SpoolRecordId,
} from './scope.ts'

/** Spoolman keeps `location` in a 64-character column. */
export const MAX_LOCATION_LENGTH = 64
const MAX_LABEL_LENGTH = 2048
const MAX_SPOOL_ID = 2_147_483_647

export interface FinderSpool {
  id: SpoolRecordId
  location: string | null
  archived: boolean
}

export type FinderStoreFailure = 'not-found' | 'denied' | 'unavailable'
export type FinderStoreResult<T> =
  { ok: true; value: T } | { ok: false; reason: FinderStoreFailure }

/** The two operations a scan needs, over any Spoolman-backed spool store. */
export interface SpoolFinderStore {
  /** Identifies the store (farm or server) so locks never cross stores. */
  readonly scope: string
  get(id: SpoolRecordId): Promise<FinderStoreResult<FinderSpool>>
  setLocation(
    id: SpoolRecordId,
    location: string,
  ): Promise<FinderStoreResult<FinderSpool>>
}

export type ScanRefusal =
  | 'invalid-location'
  | 'unknown-label'
  | 'wrong-farm'
  | 'archived'
  | 'denied'
  | 'unavailable'
  | 'uncertain'

export type ScanResult =
  | {
      ok: true
      status: 'moved' | 'unchanged'
      spoolId: SpoolRecordId
      from: string | null
      to: string
      message: string
    }
  | { ok: false; reason: ScanRefusal; message: string }

const REFUSAL_MESSAGES: Record<ScanRefusal, string> = {
  'invalid-location': `Informe um local de 1 a ${MAX_LOCATION_LENGTH} caracteres, sem caracteres de controle.`,
  'unknown-label':
    'Etiqueta não reconhecida: escaneie uma etiqueta QR de bobina desta farm.',
  'wrong-farm': 'Esta etiqueta pertence a outra farm.',
  archived: 'A bobina está arquivada e não pode mudar de local.',
  denied: 'Sua conta não tem permissão para alterar o local das bobinas.',
  unavailable:
    'Biblioteca de bobinas indisponível. Nada foi alterado; tente novamente.',
  uncertain:
    'Não foi possível confirmar a alteração. Confira o local da bobina antes de escanear de novo.',
}

function refuse(reason: ScanRefusal): ScanResult {
  return { ok: false, reason, message: REFUSAL_MESSAGES[reason] }
}

const LABEL_PATH =
  /^\/api\/farms\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/spool-library\/labels\/spool\/(\d{1,10})\/?$/i

function spoolIdFrom(text: string): number | null {
  const id = Number(text)
  return Number.isSafeInteger(id) && id >= 1 && id <= MAX_SPOOL_ID ? id : null
}

export type ParsedLabel =
  { ok: true; spoolId: SpoolRecordId; farmId: string | null } | { ok: false }

/**
 * Accepts the URL printed in a spool label's QR code
 * (`/api/farms/<farm>/spool-library/labels/spool/<id>`) or a typed `#<id>`.
 */
export function parseSpoolLabel(raw: unknown): ParsedLabel {
  if (typeof raw !== 'string') return { ok: false }
  const text = raw.trim()
  if (!text || text.length > MAX_LABEL_LENGTH) return { ok: false }
  const typed = /^#?(\d{1,10})$/.exec(text)
  if (typed) {
    const spoolId = spoolIdFrom(typed[1]!)
    return spoolId === null
      ? { ok: false }
      : { ok: true, spoolId, farmId: null }
  }
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { ok: false }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    return { ok: false }
  const match = LABEL_PATH.exec(url.pathname)
  if (!match) return { ok: false }
  const spoolId = spoolIdFrom(match[2]!)
  return spoolId === null
    ? { ok: false }
    : { ok: true, spoolId, farmId: match[1]!.toLowerCase() }
}

/** Trims a typed location; null when empty, too long or holding control characters. */
export function normalizeLocation(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  // Tabs and line breaks are control characters: refuse them before spaces collapse.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(raw)) return null
  const text = raw.trim().replace(/ {2,}/g, ' ')
  if (!text || text.length > MAX_LOCATION_LENGTH) return null
  return text
}

const inFlight = new Map<string, Promise<unknown>>()

/** Runs `work` after every earlier task on the same key has settled. */
async function serialised<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = inFlight.get(key) ?? Promise.resolve()
  const next = previous.then(work, work)
  const tail = next.catch(() => undefined)
  inFlight.set(key, tail)
  try {
    return await next
  } finally {
    if (inFlight.get(key) === tail) inFlight.delete(key)
  }
}

export interface ScanInput {
  /** What the scanner read from the label. */
  label: unknown
  /** The shelf, box or printer the spool is being put at. */
  location: unknown
  /** When set, a label printed for another farm is refused. */
  farmId?: string
}

export async function scanSpoolLabel(
  store: SpoolFinderStore,
  input: ScanInput,
): Promise<ScanResult> {
  const location = normalizeLocation(input.location)
  if (location === null) return refuse('invalid-location')
  const parsed = parseSpoolLabel(input.label)
  if (!parsed.ok) return refuse('unknown-label')
  if (
    input.farmId !== undefined &&
    parsed.farmId !== null &&
    parsed.farmId !== input.farmId.toLowerCase()
  )
    return refuse('wrong-farm')

  const id = parsed.spoolId
  return serialised(`${store.scope}#${id}`, async () => {
    const current = await store.get(id)
    if (!current.ok)
      return refuse(
        current.reason === 'not-found' ? 'unknown-label' : current.reason,
      )
    if (current.value.archived) return refuse('archived')
    if (current.value.location === location)
      return {
        ok: true,
        status: 'unchanged',
        spoolId: id,
        from: location,
        to: location,
        message: `A bobina #${id} já está em “${location}”. Nada foi alterado.`,
      }
    const written = await store.setLocation(id, location)
    if (!written.ok) {
      // The request may or may not have reached the store: never retry it.
      if (written.reason === 'unavailable') return refuse('uncertain')
      return refuse(
        written.reason === 'not-found' ? 'unknown-label' : written.reason,
      )
    }
    return {
      ok: true,
      status: 'moved',
      spoolId: id,
      from: current.value.location,
      to: location,
      message: `Bobina #${id} movida para “${location}”.`,
    }
  })
}

function toFinderSpool(spool: {
  id: number
  location: string | null
  archived: boolean
}): FinderSpool {
  return { id: spool.id, location: spool.location, archived: spool.archived }
}

function storeFailure(reason: string): FinderStoreFailure {
  if (reason === 'not-found') return 'not-found'
  if (
    reason === 'denied' ||
    reason === 'forbidden' ||
    reason === 'unauthorized'
  )
    return 'denied'
  return 'unavailable'
}

/** The farm's own spool library (Postgres-backed, Spoolman-compatible). */
export function repositoryFinderStore(
  repository: Pick<SpoolLibraryRepository, 'farmId' | 'spools'>,
): SpoolFinderStore {
  return {
    scope: `farm:${repository.farmId}`,
    async get(id) {
      const found = await repository.spools.get(id)
      return found.ok
        ? { ok: true, value: toFinderSpool(found.value) }
        : { ok: false, reason: storeFailure(found.reason) }
    },
    async setLocation(id, location) {
      const updated = await repository.spools.update(id, { location })
      return updated.ok
        ? { ok: true, value: toFinderSpool(updated.value) }
        : { ok: false, reason: storeFailure(updated.reason) }
    },
  }
}

/** Scans a label for one signed-in session, inside one farm-scoped transaction. */
export async function scanForAuthority(
  storage: Pick<SpoolLibraryStorage, 'withScope'>,
  authority: SpoolLibraryAuthority,
  input: Omit<ScanInput, 'farmId'>,
): Promise<ScanResult> {
  let result: ScanResult | undefined
  const scoped = await storage.withScope(
    authority,
    async (repository): Promise<Result<true>> => {
      if (repository.access === 'read') {
        result = refuse('denied')
        return { ok: true, value: true }
      }
      result = await scanSpoolLabel(repositoryFinderStore(repository), {
        ...input,
        farmId: repository.farmId,
      })
      return { ok: true, value: true }
    },
  )
  if (!scoped.ok)
    return refuse(
      storeFailure(scoped.reason) === 'denied' ? 'denied' : 'unavailable',
    )
  return result ?? refuse('unavailable')
}

export interface SpoolmanFinderOptions {
  /** Spoolman origin, for example http://spoolman.lan:7912 (no path). */
  origin: string
  bearerToken?: string | undefined
  fetch?: typeof fetch
  timeoutMs?: number
}

interface SpoolmanSpoolBody {
  id?: unknown
  location?: unknown
  archived?: unknown
}

function fromSpoolmanBody(body: unknown): FinderSpool | null {
  if (!body || typeof body !== 'object') return null
  const spool = body as SpoolmanSpoolBody
  if (typeof spool.id !== 'number' || !Number.isSafeInteger(spool.id))
    return null
  if (
    spool.location !== null &&
    spool.location !== undefined &&
    typeof spool.location !== 'string'
  )
    return null
  return {
    id: spool.id,
    location: typeof spool.location === 'string' ? spool.location : null,
    archived: spool.archived === true,
  }
}

/**
 * A Spoolman REST client for the two calls a scan needs (`GET` and `PATCH` of
 * `/api/v1/spool/{id}`). The write is sent once; a failed or timed-out write is
 * reported as unavailable and never repeated here.
 */
export function spoolmanFinderStore(
  options: SpoolmanFinderOptions,
): SpoolFinderStore {
  const origin = options.origin.replace(/\/+$/, '')
  const doFetch = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? 5000

  async function call(
    id: SpoolRecordId,
    init: { method: 'GET' | 'PATCH'; body?: string },
  ): Promise<FinderStoreResult<FinderSpool>> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (init.body !== undefined) headers['Content-Type'] = 'application/json'
    if (options.bearerToken)
      headers['Authorization'] = `Bearer ${options.bearerToken}`
    try {
      const response = await doFetch(`${origin}/api/v1/spool/${id}`, {
        method: init.method,
        headers,
        ...(init.body !== undefined ? { body: init.body } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (response.status === 404) return { ok: false, reason: 'not-found' }
      if (response.status === 401 || response.status === 403)
        return { ok: false, reason: 'denied' }
      if (!response.ok) return { ok: false, reason: 'unavailable' }
      const spool = fromSpoolmanBody(await response.json())
      return spool
        ? { ok: true, value: spool }
        : { ok: false, reason: 'unavailable' }
    } catch {
      return { ok: false, reason: 'unavailable' }
    }
  }

  return {
    scope: `spoolman:${origin}`,
    get: (id) => call(id, { method: 'GET' }),
    setLocation: (id, location) =>
      call(id, { method: 'PATCH', body: JSON.stringify({ location }) }),
  }
}
