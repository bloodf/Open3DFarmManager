// SPDX-License-Identifier: MIT
import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { createHash } from 'node:crypto'
import type { Duplex } from 'node:stream'
import seedData from '../../../../infra/sim/spoolman/seed.json' with { type: 'json' }
import { FaultController } from './faults.ts'
import { ScenarioController, type ScenarioStep } from './scenario.ts'
import type { HttpCallRecord } from './http-mock.ts'

export interface SpoolmanVendorRecord {
  id: number
  registered: string
  name: string | null
  comment: string | null
  empty_spool_weight: number | null
  extra: Record<string, string>
}

export interface SpoolmanFilamentRecord {
  id: number
  registered: string
  name: string | null
  vendor_id: number | null
  material: string | null
  price: number | null
  density: number | null
  diameter: number | null
  weight: number | null
  spool_weight: number | null
  article_number: string | null
  comment: string | null
  settings_extruder_temp: number | null
  settings_bed_temp: number | null
  color_hex: string | null
  multi_color_hexes: string | null
  multi_color_direction: string | null
  external_id: string | null
  extra: Record<string, string>
}

export interface SpoolmanSpoolRecord {
  id: number
  registered: string
  first_used: string | null
  last_used: string | null
  filament_id: number
  price: number | null
  initial_weight: number | null
  spool_weight: number | null
  used_weight: number | null
  remaining_weight: number | null
  location: string | null
  lot_nr: string | null
  comment: string | null
  archived: boolean
  extra: Record<string, string>
}

export interface SpoolmanHydratedFilament extends Omit<
  SpoolmanFilamentRecord,
  'vendor_id'
> {
  vendor: SpoolmanVendorRecord | null
}

export interface SpoolmanHydratedSpool extends Omit<
  SpoolmanSpoolRecord,
  'filament_id'
> {
  filament: SpoolmanHydratedFilament
}

export interface SpoolmanAuthOptions {
  headerName?: string | undefined
  token?: string | undefined
  bearer?: string | undefined
  apiKey?: string | undefined
  validate?: ((headers: IncomingMessage['headers']) => boolean) | undefined
  allowHealthWithoutAuth?: boolean | undefined
}

export type SpoolmanSchemaDriftMode =
  | 'wrapped-list'
  | 'missing-filament'
  | 'missing-archived'
  | 'string-weights'
  | 'bad-color-hex'
  | 'descending-ids'
  | 'duplicate-id'
  | 'missing-info-version'

export type SpoolmanSchemaDrift =
  | SpoolmanSchemaDriftMode
  | {
      path?: string | RegExp | undefined
      transform: (
        payload: unknown,
        ctx: { method: string; path: string },
      ) => unknown
    }

export interface SpoolmanWsEvent {
  type: 'added' | 'updated' | 'deleted'
  resource: 'spool' | 'filament' | 'vendor'
  date: string
  payload: unknown
}

export interface SpoolmanModelSnapshot {
  vendors: SpoolmanVendorRecord[]
  filaments: SpoolmanFilamentRecord[]
  spools: SpoolmanSpoolRecord[]
}

export interface SpoolmanMockOptions {
  /** Seed with infra/sim/spoolman/seed.json on startup (default: true). */
  seeded?: boolean | undefined
  /** Spool IDs to mark archived initially when seeded. */
  archivedSpoolIds?: number[] | undefined
  /** Optional auth header requirement. */
  auth?: string | SpoolmanAuthOptions | undefined
  /** Optional initial schema drift fault mode. */
  schemaDrift?: SpoolmanSchemaDrift | undefined
  /** Optional scenario steps. */
  scenario?: ScenarioStep<SpoolmanModelSnapshot>[] | undefined
}

export interface SpoolmanMockInstance {
  origin: string
  ports: { default: number; http: number } & number[]
  control: {
    faults: FaultController
    scenario: ScenarioController<SpoolmanModelSnapshot>
    sockets: Set<Duplex>
    setAuth: (auth: string | SpoolmanAuthOptions | null) => void
    setSchemaDrift: (drift: SpoolmanSchemaDrift | null) => void
    getSchemaDrift: () => SpoolmanSchemaDrift | null
    seed: () => { vendors: number; filaments: number; spools: number }
    reset: (options?: {
      seeded?: boolean | undefined
      archivedSpoolIds?: number[] | undefined
    }) => void
    getState: () => SpoolmanModelSnapshot
    emitEvent: (event: SpoolmanWsEvent) => void
  }
  calls: {
    (): Readonly<Record<string, number>>
    all: readonly HttpCallRecord[]
  }
  close: () => Promise<void>
}

function roundWeight(value: number): number {
  return Number(value.toFixed(10))
}

function frameWs(opcode: number, payload: Buffer): Buffer {
  let header: Buffer
  if (payload.length < 126) {
    header = Buffer.alloc(2)
    header[1] = payload.length
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  header[0] = 0x80 | opcode
  return Buffer.concat([header, payload])
}

function normalizeExtra(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function sortItems<T extends Record<string, unknown>>(
  items: T[],
  sortParam: string | null,
): T[] {
  const specs = (sortParam ?? 'id:asc')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [field, dir] = part.split(':')
      return {
        field: field || 'id',
        desc: dir?.toLowerCase() === 'desc',
      }
    })
  if (specs.length === 0) specs.push({ field: 'id', desc: false })

  return [...items].sort((a, b) => {
    for (const spec of specs) {
      const av = getNestedValue(a, spec.field)
      const bv = getNestedValue(b, spec.field)
      if (av === bv) continue
      if (av === null || av === undefined) return spec.desc ? -1 : 1
      if (bv === null || bv === undefined) return spec.desc ? 1 : -1
      let cmp = 0
      if (typeof av === 'number' && typeof bv === 'number') {
        cmp = av - bv
      } else {
        cmp = String(av).localeCompare(String(bv))
      }
      if (cmp !== 0) return spec.desc ? -cmp : cmp
    }
    return 0
  })
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  let current: unknown = obj
  for (const key of path.split('.')) {
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function paginate<T>(items: T[], searchParams: URLSearchParams): T[] {
  const offsetRaw = searchParams.get('offset')
  const limitRaw = searchParams.get('limit')
  const offset =
    offsetRaw !== null && /^\d+$/.test(offsetRaw) ? Number(offsetRaw) : 0
  if (limitRaw !== null && /^\d+$/.test(limitRaw)) {
    const limit = Number(limitRaw)
    return items.slice(offset, offset + limit)
  }
  return items.slice(offset)
}

function parsePositiveId(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null
  const num = Number(raw)
  return Number.isSafeInteger(num) && num > 0 ? num : null
}

function applySchemaDrift(
  payload: unknown,
  drift: SpoolmanSchemaDrift | null,
  ctx: { method: string; path: string },
): unknown {
  if (!drift) return payload
  if (typeof drift === 'object') {
    if (drift.path) {
      if (typeof drift.path === 'string' && drift.path !== ctx.path) {
        return payload
      }
      if (drift.path instanceof RegExp && !drift.path.test(ctx.path)) {
        return payload
      }
    }
    return drift.transform(structuredClone(payload), ctx)
  }

  switch (drift) {
    case 'wrapped-list':
      return Array.isArray(payload) ? { items: payload } : payload
    case 'missing-filament':
      if (Array.isArray(payload)) {
        return payload.map((item) =>
          item && typeof item === 'object' ? { ...item, filament: null } : item,
        )
      }
      if (payload && typeof payload === 'object' && 'filament' in payload) {
        return { ...(payload as Record<string, unknown>), filament: null }
      }
      return payload
    case 'missing-archived':
      if (Array.isArray(payload)) {
        return payload.map((item) => {
          if (!item || typeof item !== 'object') return item
          const copy = { ...(item as Record<string, unknown>) }
          delete copy.archived
          return copy
        })
      }
      if (payload && typeof payload === 'object' && 'archived' in payload) {
        const copy = { ...(payload as Record<string, unknown>) }
        delete copy.archived
        return copy
      }
      return payload
    case 'string-weights':
      if (Array.isArray(payload)) {
        return payload.map((item) => {
          if (!item || typeof item !== 'object') return item
          const rec = item as Record<string, unknown>
          return {
            ...rec,
            ...(rec.remaining_weight !== undefined &&
            rec.remaining_weight !== null
              ? { remaining_weight: String(rec.remaining_weight) }
              : {}),
            ...(rec.used_weight !== undefined && rec.used_weight !== null
              ? { used_weight: String(rec.used_weight) }
              : {}),
          }
        })
      }
      return payload
    case 'bad-color-hex':
      if (Array.isArray(payload)) {
        return payload.map((item) => {
          if (!item || typeof item !== 'object') return item
          const rec = item as Record<string, unknown>
          if (rec.filament && typeof rec.filament === 'object') {
            return {
              ...rec,
              filament: {
                ...(rec.filament as Record<string, unknown>),
                color_hex: 'NOT_HEX',
              },
            }
          }
          if ('color_hex' in rec) {
            return { ...rec, color_hex: 'NOT_HEX' }
          }
          return item
        })
      }
      return payload
    case 'descending-ids':
      return Array.isArray(payload) ? [...payload].reverse() : payload
    case 'duplicate-id':
      return Array.isArray(payload) && payload.length > 0
        ? [payload[0], ...payload]
        : payload
    case 'missing-info-version':
      if (
        ctx.path === '/api/v1/info' &&
        payload &&
        typeof payload === 'object'
      ) {
        const copy = { ...(payload as Record<string, unknown>) }
        delete copy.version
        return copy
      }
      return payload
    default:
      return payload
  }
}

export async function startSpoolmanMock(
  options: SpoolmanMockOptions = {},
): Promise<SpoolmanMockInstance> {
  const faults = new FaultController()
  const rawSockets = new Set<Duplex>()
  const wsSubscribers = new Set<(msg: string) => void>()
  const callRecords: HttpCallRecord[] = []
  const callCounts: Record<string, number> = {}

  let authConfig: string | SpoolmanAuthOptions | null = options.auth ?? null
  let schemaDrift: SpoolmanSchemaDrift | null = options.schemaDrift ?? null

  const vendors = new Map<number, SpoolmanVendorRecord>()
  const filaments = new Map<number, SpoolmanFilamentRecord>()
  const spools = new Map<number, SpoolmanSpoolRecord>()
  let nextVendorId = 1
  let nextFilamentId = 1
  let nextSpoolId = 1

  const recordCall = (key: string) => {
    callCounts[key] = (callCounts[key] ?? 0) + 1
  }

  function hydrateFilament(
    filament: SpoolmanFilamentRecord,
  ): SpoolmanHydratedFilament {
    const { vendor_id, ...rest } = filament
    const vendor = vendor_id !== null ? (vendors.get(vendor_id) ?? null) : null
    return {
      ...structuredClone(rest),
      vendor: vendor ? structuredClone(vendor) : null,
    }
  }

  function hydrateSpool(spool: SpoolmanSpoolRecord): SpoolmanHydratedSpool {
    const { filament_id, ...rest } = spool
    const filament = filaments.get(filament_id)
    if (!filament) {
      throw new Error(`Missing filament ${filament_id} for spool ${spool.id}`)
    }
    return {
      ...structuredClone(rest),
      filament: hydrateFilament(filament),
    }
  }

  function emitEvent(event: SpoolmanWsEvent) {
    const wire = JSON.stringify(event)
    for (const send of wsSubscribers) {
      send(wire)
    }
  }

  function seedInventory(archivedIds: number[] = []) {
    const nowIso = '2026-01-01T00:00:00.000Z'
    const archivedSet = new Set(archivedIds)
    const vendorIds: number[] = []
    for (const v of seedData.vendors) {
      const existing = [...vendors.values()].find(
        (item) => item.name === v.name,
      )
      if (existing) {
        vendorIds.push(existing.id)
        continue
      }
      const id = nextVendorId++
      vendors.set(id, {
        id,
        registered: nowIso,
        name: v.name,
        comment: null,
        empty_spool_weight: null,
        extra: {},
      })
      vendorIds.push(id)
    }

    const filamentIds: number[] = []
    for (const { vendor, ...f } of seedData.filaments) {
      const vendorId = vendorIds[vendor] ?? null
      const existing = [...filaments.values()].find(
        (item) => item.name === f.name,
      )
      if (existing) {
        filamentIds.push(existing.id)
        continue
      }
      const id = nextFilamentId++
      filaments.set(id, {
        id,
        registered: nowIso,
        name: f.name,
        vendor_id: vendorId,
        material: f.material,
        price: null,
        density: f.density,
        diameter: f.diameter,
        weight: f.weight,
        spool_weight: null,
        article_number: null,
        comment: null,
        settings_extruder_temp: null,
        settings_bed_temp: null,
        color_hex: f.color_hex,
        multi_color_hexes: null,
        multi_color_direction: null,
        external_id: null,
        extra: {},
      })
      filamentIds.push(id)
    }

    let seededSpools = 0
    for (const { filament, ...s } of seedData.spools) {
      const filamentId = filamentIds[filament]
      if (!filamentId) throw new Error('Invalid seed filament reference')
      const existing = [...spools.values()].find(
        (item) => item.comment === s.comment,
      )
      if (existing) {
        seededSpools++
        continue
      }
      const id = nextSpoolId++
      const initialWeight = s.initial_weight
      const usedWeight = s.used_weight
      spools.set(id, {
        id,
        registered: nowIso,
        first_used: null,
        last_used: null,
        filament_id: filamentId,
        price: null,
        initial_weight: initialWeight,
        spool_weight: null,
        used_weight: usedWeight,
        remaining_weight: roundWeight(Math.max(0, initialWeight - usedWeight)),
        location: null,
        lot_nr: null,
        comment: s.comment,
        archived: archivedSet.has(id),
        extra: {},
      })
      seededSpools++
    }

    return {
      vendors: vendorIds.length,
      filaments: filamentIds.length,
      spools: seededSpools,
    }
  }

  function resetInventory(opts?: {
    seeded?: boolean | undefined
    archivedSpoolIds?: number[] | undefined
  }) {
    vendors.clear()
    filaments.clear()
    spools.clear()
    nextVendorId = 1
    nextFilamentId = 1
    nextSpoolId = 1
    if (opts?.seeded ?? true) {
      seedInventory(opts?.archivedSpoolIds)
    }
  }

  if (options.seeded ?? true) {
    seedInventory(options.archivedSpoolIds)
  }

  const getSnapshot = (): SpoolmanModelSnapshot => ({
    vendors: structuredClone([...vendors.values()]),
    filaments: structuredClone([...filaments.values()]),
    spools: structuredClone([...spools.values()]),
  })

  const scenario = new ScenarioController<SpoolmanModelSnapshot>({
    steps: options.scenario,
    applyState: (patch) => {
      if (patch.vendors) {
        vendors.clear()
        for (const v of patch.vendors) vendors.set(v.id, structuredClone(v))
        nextVendorId = Math.max(1, ...patch.vendors.map((v) => v.id + 1))
      }
      if (patch.filaments) {
        filaments.clear()
        for (const f of patch.filaments) filaments.set(f.id, structuredClone(f))
        nextFilamentId = Math.max(1, ...patch.filaments.map((f) => f.id + 1))
      }
      if (patch.spools) {
        spools.clear()
        for (const s of patch.spools) spools.set(s.id, structuredClone(s))
        nextSpoolId = Math.max(1, ...patch.spools.map((s) => s.id + 1))
      }
    },
    publishReport: (report) => {
      if (report && typeof report === 'object' && 'resource' in report) {
        emitEvent(report as SpoolmanWsEvent)
      }
    },
    getState: getSnapshot,
  })

  function checkAuth(
    headers: IncomingMessage['headers'],
    path: string,
  ): boolean {
    if (!authConfig) return true
    if (
      typeof authConfig === 'object' &&
      authConfig.allowHealthWithoutAuth !== false &&
      (path === '/health' || path === '/api/v1/health')
    ) {
      return true
    }
    if (
      typeof authConfig === 'string' &&
      (path === '/health' || path === '/api/v1/health')
    ) {
      return true
    }

    if (typeof authConfig === 'string') {
      return (
        headers.authorization === authConfig ||
        headers['x-api-key'] === authConfig
      )
    }
    if (authConfig.validate) {
      return authConfig.validate(headers)
    }
    if (authConfig.headerName && authConfig.token !== undefined) {
      const value = headers[authConfig.headerName.toLowerCase()]
      return value === authConfig.token
    }
    if (authConfig.bearer !== undefined) {
      return headers.authorization === `Bearer ${authConfig.bearer}`
    }
    if (authConfig.apiKey !== undefined) {
      return headers['x-api-key'] === authConfig.apiKey
    }
    if (authConfig.token !== undefined) {
      return (
        headers.authorization === authConfig.token ||
        headers['x-api-key'] === authConfig.token
      )
    }
    return true
  }

  function sendJson(
    res: ServerResponse,
    status: number,
    payload: unknown,
    extraHeaders?: Record<string, string>,
  ) {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      ...extraHeaders,
    })
    res.end(JSON.stringify(payload))
  }

  function parseJsonBody(
    body: Buffer,
  ): { ok: true; value: Record<string, unknown> } | { ok: false } {
    if (body.length === 0) return { ok: true, value: {} }
    try {
      const parsed = JSON.parse(body.toString('utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false }
      }
      return { ok: true, value: parsed as Record<string, unknown> }
    } catch {
      return { ok: false }
    }
  }

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', async () => {
      const body = Buffer.concat(chunks)
      const rawUrl = req.url ?? '/'
      const parsedUrl = new URL(rawUrl, 'http://127.0.0.1')
      const path = parsedUrl.pathname
      const method = (req.method ?? 'GET').toUpperCase()

      recordCall(method)
      recordCall(`${method} ${path}`)

      const pushCall = (status: number) => {
        callRecords.push({
          method,
          url: rawUrl,
          headers: req.headers,
          body,
          status,
          timestamp: Date.now(),
        })
      }

      const fault = faults.matchFault({ path, method, headers: req.headers })
      if (fault) {
        if (fault.type === 'drop') {
          req.socket.destroy()
          return
        }
        if (fault.type === 'refuse') {
          const status = fault.statusCode ?? 503
          sendJson(res, status, {
            message:
              fault.message ??
              (status === 500
                ? 'Internal Server Error'
                : 'Service Unavailable'),
          })
          pushCall(status)
          return
        }
        if (fault.type === 'malformed') {
          const bad = fault.payload ?? 'NOT_A_VALID_HTTP_RESPONSE\r\n\r\n'
          req.socket.write(bad)
          req.socket.destroy()
          return
        }
        if (fault.type === 'delay') {
          await new Promise((resolve) => setTimeout(resolve, fault.delayMs))
          if (req.socket.destroyed || res.writableEnded) return
        }
        if (fault.type === 'stall') {
          return
        }
      }

      if (!checkAuth(req.headers, path)) {
        sendJson(res, 401, { message: 'Unauthorized' })
        pushCall(401)
        return
      }

      const respond = (
        status: number,
        payload: unknown,
        extraHeaders?: Record<string, string>,
      ) => {
        const out =
          status === 200
            ? applySchemaDrift(payload, schemaDrift, { method, path })
            : payload
        sendJson(res, status, out, extraHeaders)
        pushCall(status)
      }

      if (
        method === 'GET' &&
        (path === '/health' || path === '/api/v1/health')
      ) {
        return respond(200, { status: 'healthy' })
      }

      if (method === 'GET' && path === '/api/v1/info') {
        return respond(200, {
          version: '0.20.0',
          debug_mode: false,
          automatic_backups: true,
          data_dir: '/home/app/.local/share/spoolman',
          logs_dir: '/home/app/.local/share/spoolman',
          backups_dir: '/home/app/.local/share/spoolman/backups',
          db_type: 'sqlite',
          git_commit: 'mock',
          build_date: '2026-01-01T00:00:00Z',
        })
      }

      // /api/v1/vendor
      if (path === '/api/v1/vendor') {
        if (method === 'GET') {
          let list = [...vendors.values()].map((v) => structuredClone(v))
          const nameFilter = parsedUrl.searchParams.get('name')
          if (nameFilter) {
            const needle = nameFilter.toLowerCase()
            list = list.filter((v) => v.name?.toLowerCase().includes(needle))
          }
          const sorted = sortItems(
            list as unknown as Record<string, unknown>[],
            parsedUrl.searchParams.get('sort'),
          )
          const page = paginate(sorted, parsedUrl.searchParams)
          return respond(200, page, {
            'X-Total-Count': String(sorted.length),
          })
        }
        if (method === 'POST') {
          const parsed = parseJsonBody(body)
          if (!parsed.ok) return respond(400, { message: 'Invalid JSON body' })
          const data = parsed.value
          const nowIso = new Date().toISOString()
          const vendor: SpoolmanVendorRecord = {
            id: nextVendorId++,
            registered: nowIso,
            name: asNullableString(data.name),
            comment: asNullableString(data.comment),
            empty_spool_weight: asNullableNumber(data.empty_spool_weight),
            extra: normalizeExtra(data.extra),
          }
          vendors.set(vendor.id, vendor)
          emitEvent({
            type: 'added',
            resource: 'vendor',
            date: nowIso,
            payload: structuredClone(vendor),
          })
          return respond(200, structuredClone(vendor))
        }
      }

      const vendorMatch = /^\/api\/v1\/vendor\/([^/]+)$/.exec(path)
      if (vendorMatch) {
        const id = parsePositiveId(vendorMatch[1])
        if (id === null) return respond(422, { message: 'Invalid vendor id' })
        const vendor = vendors.get(id)
        if (!vendor) return respond(404, { message: 'Vendor not found' })
        if (method === 'GET') {
          return respond(200, structuredClone(vendor))
        }
        if (method === 'PATCH') {
          const parsed = parseJsonBody(body)
          if (!parsed.ok) return respond(400, { message: 'Invalid JSON body' })
          const data = parsed.value
          if ('name' in data) vendor.name = asNullableString(data.name)
          if ('comment' in data) vendor.comment = asNullableString(data.comment)
          if ('empty_spool_weight' in data) {
            vendor.empty_spool_weight = asNullableNumber(
              data.empty_spool_weight,
            )
          }
          if ('extra' in data) vendor.extra = normalizeExtra(data.extra)
          const nowIso = new Date().toISOString()
          emitEvent({
            type: 'updated',
            resource: 'vendor',
            date: nowIso,
            payload: structuredClone(vendor),
          })
          return respond(200, structuredClone(vendor))
        }
        if (method === 'DELETE') {
          const snapshot = structuredClone(vendor)
          vendors.delete(id)
          for (const filament of filaments.values()) {
            if (filament.vendor_id === id) filament.vendor_id = null
          }
          emitEvent({
            type: 'deleted',
            resource: 'vendor',
            date: new Date().toISOString(),
            payload: snapshot,
          })
          return respond(200, { message: 'Success!' })
        }
      }

      // /api/v1/filament
      if (path === '/api/v1/filament') {
        if (method === 'GET') {
          let list = [...filaments.values()].map(hydrateFilament)
          const vendorFilter = parsedUrl.searchParams.get('vendor_id')
          if (vendorFilter) {
            const ids = new Set(
              vendorFilter
                .split(',')
                .map((x) => Number(x.trim()))
                .filter((x) => Number.isInteger(x)),
            )
            list = list.filter((f) => f.vendor && ids.has(f.vendor.id))
          }
          const materialFilter = parsedUrl.searchParams.get('material')
          if (materialFilter) {
            const needle = materialFilter.toLowerCase()
            list = list.filter((f) =>
              f.material?.toLowerCase().includes(needle),
            )
          }
          const nameFilter = parsedUrl.searchParams.get('name')
          if (nameFilter) {
            const needle = nameFilter.toLowerCase()
            list = list.filter((f) => f.name?.toLowerCase().includes(needle))
          }
          const sorted = sortItems(
            list as unknown as Record<string, unknown>[],
            parsedUrl.searchParams.get('sort'),
          )
          const page = paginate(sorted, parsedUrl.searchParams)
          return respond(200, page, {
            'X-Total-Count': String(sorted.length),
          })
        }
        if (method === 'POST') {
          const parsed = parseJsonBody(body)
          if (!parsed.ok) return respond(400, { message: 'Invalid JSON body' })
          const data = parsed.value
          const vendorId = asNullableNumber(data.vendor_id)
          if (data.vendor_id !== undefined && data.vendor_id !== null) {
            if (vendorId === null || !vendors.has(vendorId)) {
              return respond(422, { message: 'Vendor not found' })
            }
          }
          const nowIso = new Date().toISOString()
          const filament: SpoolmanFilamentRecord = {
            id: nextFilamentId++,
            registered: nowIso,
            name: asNullableString(data.name),
            vendor_id: vendorId,
            material: asNullableString(data.material),
            price: asNullableNumber(data.price),
            density: asNullableNumber(data.density),
            diameter: asNullableNumber(data.diameter),
            weight: asNullableNumber(data.weight),
            spool_weight: asNullableNumber(data.spool_weight),
            article_number: asNullableString(data.article_number),
            comment: asNullableString(data.comment),
            settings_extruder_temp: asNullableNumber(
              data.settings_extruder_temp,
            ),
            settings_bed_temp: asNullableNumber(data.settings_bed_temp),
            color_hex: asNullableString(data.color_hex),
            multi_color_hexes: asNullableString(data.multi_color_hexes),
            multi_color_direction: asNullableString(data.multi_color_direction),
            external_id: asNullableString(data.external_id),
            extra: normalizeExtra(data.extra),
          }
          filaments.set(filament.id, filament)
          const hydrated = hydrateFilament(filament)
          emitEvent({
            type: 'added',
            resource: 'filament',
            date: nowIso,
            payload: hydrated,
          })
          return respond(200, hydrated)
        }
      }

      const filamentMatch = /^\/api\/v1\/filament\/([^/]+)$/.exec(path)
      if (filamentMatch) {
        const id = parsePositiveId(filamentMatch[1])
        if (id === null) return respond(422, { message: 'Invalid filament id' })
        const filament = filaments.get(id)
        if (!filament) return respond(404, { message: 'Filament not found' })
        if (method === 'GET') {
          return respond(200, hydrateFilament(filament))
        }
        if (method === 'PATCH') {
          const parsed = parseJsonBody(body)
          if (!parsed.ok) return respond(400, { message: 'Invalid JSON body' })
          const data = parsed.value
          if ('vendor_id' in data) {
            const vendorId = asNullableNumber(data.vendor_id)
            if (
              data.vendor_id !== null &&
              (vendorId === null || !vendors.has(vendorId))
            ) {
              return respond(422, { message: 'Vendor not found' })
            }
            filament.vendor_id = vendorId
          }
          if ('name' in data) filament.name = asNullableString(data.name)
          if ('material' in data)
            filament.material = asNullableString(data.material)
          if ('price' in data) filament.price = asNullableNumber(data.price)
          if ('density' in data)
            filament.density = asNullableNumber(data.density)
          if ('diameter' in data)
            filament.diameter = asNullableNumber(data.diameter)
          if ('weight' in data) filament.weight = asNullableNumber(data.weight)
          if ('spool_weight' in data)
            filament.spool_weight = asNullableNumber(data.spool_weight)
          if ('article_number' in data)
            filament.article_number = asNullableString(data.article_number)
          if ('comment' in data)
            filament.comment = asNullableString(data.comment)
          if ('settings_extruder_temp' in data) {
            filament.settings_extruder_temp = asNullableNumber(
              data.settings_extruder_temp,
            )
          }
          if ('settings_bed_temp' in data) {
            filament.settings_bed_temp = asNullableNumber(
              data.settings_bed_temp,
            )
          }
          if ('color_hex' in data)
            filament.color_hex = asNullableString(data.color_hex)
          if ('multi_color_hexes' in data) {
            filament.multi_color_hexes = asNullableString(
              data.multi_color_hexes,
            )
          }
          if ('multi_color_direction' in data) {
            filament.multi_color_direction = asNullableString(
              data.multi_color_direction,
            )
          }
          if ('external_id' in data)
            filament.external_id = asNullableString(data.external_id)
          if ('extra' in data) filament.extra = normalizeExtra(data.extra)
          const hydrated = hydrateFilament(filament)
          emitEvent({
            type: 'updated',
            resource: 'filament',
            date: new Date().toISOString(),
            payload: hydrated,
          })
          return respond(200, hydrated)
        }
        if (method === 'DELETE') {
          const snapshot = hydrateFilament(filament)
          filaments.delete(id)
          emitEvent({
            type: 'deleted',
            resource: 'filament',
            date: new Date().toISOString(),
            payload: snapshot,
          })
          return respond(200, { message: 'Success!' })
        }
      }

      // /api/v1/spool
      if (path === '/api/v1/spool') {
        if (method === 'GET') {
          const allowArchived =
            parsedUrl.searchParams.get('allow_archived') === 'true'
          let list = [...spools.values()]
            .filter((s) => allowArchived || !s.archived)
            .map(hydrateSpool)

          const filamentFilter = parsedUrl.searchParams.get('filament_id')
          if (filamentFilter) {
            const ids = new Set(
              filamentFilter
                .split(',')
                .map((x) => Number(x.trim()))
                .filter((x) => Number.isInteger(x)),
            )
            list = list.filter((s) => ids.has(s.filament.id))
          }
          const vendorFilter = parsedUrl.searchParams.get('filament.vendor_id')
          if (vendorFilter) {
            const ids = new Set(
              vendorFilter
                .split(',')
                .map((x) => Number(x.trim()))
                .filter((x) => Number.isInteger(x)),
            )
            list = list.filter(
              (s) => s.filament.vendor && ids.has(s.filament.vendor.id),
            )
          }
          const locationFilter = parsedUrl.searchParams.get('location')
          if (locationFilter) {
            const needle = locationFilter.toLowerCase()
            list = list.filter((s) =>
              s.location?.toLowerCase().includes(needle),
            )
          }
          const lotFilter = parsedUrl.searchParams.get('lot_nr')
          if (lotFilter) {
            const needle = lotFilter.toLowerCase()
            list = list.filter((s) => s.lot_nr?.toLowerCase().includes(needle))
          }

          const sorted = sortItems(
            list as unknown as Record<string, unknown>[],
            parsedUrl.searchParams.get('sort'),
          )
          const page = paginate(sorted, parsedUrl.searchParams)
          return respond(200, page, {
            'X-Total-Count': String(sorted.length),
          })
        }
        if (method === 'POST') {
          const parsed = parseJsonBody(body)
          if (!parsed.ok) return respond(400, { message: 'Invalid JSON body' })
          const data = parsed.value
          const filamentId = asNullableNumber(data.filament_id)
          if (filamentId === null || !filaments.has(filamentId)) {
            return respond(422, { message: 'Filament not found' })
          }
          const filament = filaments.get(filamentId)!
          const initialWeight =
            'initial_weight' in data
              ? asNullableNumber(data.initial_weight)
              : filament.weight
          const spoolWeight =
            'spool_weight' in data
              ? asNullableNumber(data.spool_weight)
              : filament.spool_weight
          let usedWeight: number | null
          let remainingWeight: number | null
          if (data.used_weight !== undefined && data.used_weight !== null) {
            usedWeight = asNullableNumber(data.used_weight) ?? 0
            remainingWeight =
              data.remaining_weight !== undefined
                ? asNullableNumber(data.remaining_weight)
                : initialWeight !== null
                  ? roundWeight(Math.max(0, initialWeight - usedWeight))
                  : null
          } else if (
            data.remaining_weight !== undefined &&
            data.remaining_weight !== null
          ) {
            remainingWeight = asNullableNumber(data.remaining_weight)
            usedWeight =
              initialWeight !== null && remainingWeight !== null
                ? roundWeight(Math.max(0, initialWeight - remainingWeight))
                : 0
          } else {
            usedWeight = 0
            remainingWeight = initialWeight
          }

          const nowIso = new Date().toISOString()
          const spool: SpoolmanSpoolRecord = {
            id: nextSpoolId++,
            registered: nowIso,
            first_used: asNullableString(data.first_used),
            last_used: asNullableString(data.last_used),
            filament_id: filamentId,
            price: asNullableNumber(data.price),
            initial_weight: initialWeight,
            spool_weight: spoolWeight,
            used_weight: usedWeight,
            remaining_weight: remainingWeight,
            location: asNullableString(data.location),
            lot_nr: asNullableString(data.lot_nr),
            comment: asNullableString(data.comment),
            archived: Boolean(data.archived ?? false),
            extra: normalizeExtra(data.extra),
          }
          spools.set(spool.id, spool)
          const hydrated = hydrateSpool(spool)
          emitEvent({
            type: 'added',
            resource: 'spool',
            date: nowIso,
            payload: hydrated,
          })
          return respond(200, hydrated)
        }
      }

      // PUT /api/v1/spool/:id/use
      const spoolUseMatch = /^\/api\/v1\/spool\/([^/]+)\/use$/.exec(path)
      if (spoolUseMatch) {
        if (method !== 'PUT') {
          return respond(405, { message: 'Method Not Allowed' })
        }
        const id = parsePositiveId(spoolUseMatch[1])
        if (id === null) return respond(422, { message: 'Invalid spool id' })
        const spool = spools.get(id)
        if (!spool) return respond(404, { message: 'Spool not found' })
        const parsed = parseJsonBody(body)
        if (!parsed.ok) return respond(400, { message: 'Invalid JSON body' })
        const data = parsed.value
        const hasWeight =
          data.use_weight !== undefined && data.use_weight !== null
        const hasLength =
          data.use_length !== undefined && data.use_length !== null
        if (hasWeight === hasLength) {
          return respond(400, {
            message:
              'Either use_weight or use_length must be provided, not both',
          })
        }

        let weightDelta: number
        if (hasWeight) {
          if (
            typeof data.use_weight !== 'number' ||
            !Number.isFinite(data.use_weight)
          ) {
            return respond(422, { message: 'Invalid use_weight' })
          }
          weightDelta = data.use_weight
        } else {
          if (
            typeof data.use_length !== 'number' ||
            !Number.isFinite(data.use_length)
          ) {
            return respond(422, { message: 'Invalid use_length' })
          }
          const filament = filaments.get(spool.filament_id)
          if (
            !filament ||
            filament.diameter === null ||
            filament.density === null
          ) {
            return respond(400, {
              message: 'Filament diameter or density not set',
            })
          }
          const radiusMm = filament.diameter / 2
          const volumeCm3 =
            (Math.PI * radiusMm * radiusMm * data.use_length) / 1000
          weightDelta = volumeCm3 * filament.density
        }

        const prevUsed = spool.used_weight ?? 0
        spool.used_weight = roundWeight(Math.max(0, prevUsed + weightDelta))
        if (spool.initial_weight !== null) {
          spool.remaining_weight = roundWeight(
            Math.max(0, spool.initial_weight - spool.used_weight),
          )
        } else if (spool.remaining_weight !== null) {
          spool.remaining_weight = roundWeight(
            Math.max(0, spool.remaining_weight - weightDelta),
          )
        }
        const nowIso = new Date().toISOString()
        if (spool.first_used === null) spool.first_used = nowIso
        spool.last_used = nowIso

        const hydrated = hydrateSpool(spool)
        emitEvent({
          type: 'updated',
          resource: 'spool',
          date: nowIso,
          payload: hydrated,
        })
        return respond(200, hydrated)
      }

      const spoolMatch = /^\/api\/v1\/spool\/([^/]+)$/.exec(path)
      if (spoolMatch) {
        const id = parsePositiveId(spoolMatch[1])
        if (id === null) return respond(422, { message: 'Invalid spool id' })
        const spool = spools.get(id)
        if (!spool) return respond(404, { message: 'Spool not found' })
        if (method === 'GET') {
          return respond(200, hydrateSpool(spool))
        }
        if (method === 'PATCH') {
          const parsed = parseJsonBody(body)
          if (!parsed.ok) return respond(400, { message: 'Invalid JSON body' })
          const data = parsed.value
          if ('filament_id' in data) {
            const filamentId = asNullableNumber(data.filament_id)
            if (filamentId === null || !filaments.has(filamentId)) {
              return respond(422, { message: 'Filament not found' })
            }
            spool.filament_id = filamentId
          }
          if ('initial_weight' in data) {
            spool.initial_weight = asNullableNumber(data.initial_weight)
          }
          if ('spool_weight' in data) {
            spool.spool_weight = asNullableNumber(data.spool_weight)
          }
          const hasUsed = 'used_weight' in data
          const hasRemaining = 'remaining_weight' in data
          if (hasUsed && hasRemaining) {
            spool.used_weight = asNullableNumber(data.used_weight)
            spool.remaining_weight = asNullableNumber(data.remaining_weight)
          } else if (hasRemaining) {
            spool.remaining_weight = asNullableNumber(data.remaining_weight)
            if (
              spool.initial_weight !== null &&
              spool.remaining_weight !== null
            ) {
              spool.used_weight = roundWeight(
                Math.max(0, spool.initial_weight - spool.remaining_weight),
              )
            }
          } else if (hasUsed) {
            spool.used_weight = asNullableNumber(data.used_weight)
            if (spool.initial_weight !== null && spool.used_weight !== null) {
              spool.remaining_weight = roundWeight(
                Math.max(0, spool.initial_weight - spool.used_weight),
              )
            }
          } else if ('initial_weight' in data) {
            if (spool.initial_weight !== null && spool.used_weight !== null) {
              spool.remaining_weight = roundWeight(
                Math.max(0, spool.initial_weight - spool.used_weight),
              )
            }
          }
          if ('price' in data) spool.price = asNullableNumber(data.price)
          if ('location' in data)
            spool.location = asNullableString(data.location)
          if ('lot_nr' in data) spool.lot_nr = asNullableString(data.lot_nr)
          if ('comment' in data) spool.comment = asNullableString(data.comment)
          if ('first_used' in data)
            spool.first_used = asNullableString(data.first_used)
          if ('last_used' in data)
            spool.last_used = asNullableString(data.last_used)
          if ('archived' in data) spool.archived = Boolean(data.archived)
          if ('extra' in data) spool.extra = normalizeExtra(data.extra)

          const hydrated = hydrateSpool(spool)
          emitEvent({
            type: 'updated',
            resource: 'spool',
            date: new Date().toISOString(),
            payload: hydrated,
          })
          return respond(200, hydrated)
        }
        if (method === 'DELETE') {
          const snapshot = hydrateSpool(spool)
          spools.delete(id)
          emitEvent({
            type: 'deleted',
            resource: 'spool',
            date: new Date().toISOString(),
            payload: snapshot,
          })
          return respond(200, { message: 'Success!' })
        }
      }

      return respond(404, { message: 'Not Found' })
    })
  })

  server.on('connection', (sock) => {
    rawSockets.add(sock)
    sock.on('close', () => rawSockets.delete(sock))
  })

  server.on('upgrade', (req, socket) => {
    rawSockets.add(socket)
    socket.on('close', () => rawSockets.delete(socket))

    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    if (!path.startsWith('/api/v1')) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }

    const key = req.headers['sec-websocket-key']
    if (typeof key !== 'string') {
      socket.destroy()
      return
    }

    if (!checkAuth(req.headers, path)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    const fault = faults.matchFault({
      path,
      method: 'UPGRADE',
      headers: req.headers,
    })
    if (fault) {
      if (fault.type === 'drop') {
        socket.destroy()
        return
      }
      if (fault.type === 'refuse') {
        const status = fault.statusCode ?? 503
        socket.write(`HTTP/1.1 ${status} Fault\r\n\r\n`)
        socket.destroy()
        return
      }
      if (fault.type === 'stall') {
        return
      }
    }

    const acceptKey = createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64')

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' +
        acceptKey +
        '\r\n\r\n',
    )

    const sendWs = (msg: string) => {
      if (socket.writable) {
        socket.write(frameWs(0x1, Buffer.from(msg)))
      }
    }

    wsSubscribers.add(sendWs)
    socket.once('close', () => wsSubscribers.delete(sendWs))

    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
      for (;;) {
        if (buffer.length < 2) return
        const opcode = buffer[0]! & 0x0f
        const masked = (buffer[1]! & 0x80) !== 0
        let length = buffer[1]! & 0x7f
        let offset = 2
        if (length === 126) {
          if (buffer.length < 4) return
          length = buffer.readUInt16BE(2)
          offset = 4
        } else if (length === 127) {
          if (buffer.length < 10) return
          length = Number(buffer.readBigUInt64BE(2))
          offset = 10
        }
        if (buffer.length < offset + length + (masked ? 4 : 0)) return
        const maskOffset = offset
        if (masked) offset += 4
        let payload = buffer.subarray(offset, offset + length)
        if (masked) {
          payload = Buffer.from(payload)
          for (let i = 0; i < payload.length; i++) {
            payload[i] = payload[i]! ^ buffer[maskOffset + (i % 4)]!
          }
        }
        buffer = buffer.subarray(offset + length)

        if (opcode === 0x8) {
          socket.write(frameWs(0x8, payload))
          socket.end()
          return
        }
        if (opcode === 0x9) {
          socket.write(frameWs(0xa, payload))
          continue
        }
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const addr = server.address()
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to obtain Spoolman mock listening address')
  }

  const port = addr.port
  const origin = `http://127.0.0.1:${port}`
  const ports = Object.assign([port], {
    default: port,
    http: port,
  }) as { default: number; http: number } & number[]

  const callsFn = () => ({ ...callCounts })
  Object.defineProperty(callsFn, 'all', {
    get: () => callRecords,
  })

  const close = async () => {
    scenario.stop()
    wsSubscribers.clear()
    for (const socket of rawSockets) {
      socket.destroy()
    }
    rawSockets.clear()
    server.closeAllConnections()
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  }

  return {
    origin,
    ports,
    control: {
      faults,
      scenario,
      sockets: rawSockets,
      setAuth: (auth) => {
        authConfig = auth
      },
      setSchemaDrift: (drift) => {
        schemaDrift = drift
      },
      getSchemaDrift: () => schemaDrift,
      seed: () => seedInventory(),
      reset: resetInventory,
      getState: getSnapshot,
      emitEvent,
    },
    calls: callsFn as SpoolmanMockInstance['calls'],
    close,
  }
}
