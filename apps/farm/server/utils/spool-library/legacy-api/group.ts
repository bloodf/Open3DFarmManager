/**
 * `GET /api/v1/spool/group` of the pinned Spoolman v0.27.1: this farm's spools
 * filtered like the spool find endpoint, grouped by one axis, with per-group
 * aggregates. Pagination is over whole groups.
 */
import type { Spool, SpoolFilament, SpoolVendor } from '../scope.ts'
import { spoolmanDateTime } from './compat.ts'
import { ID_LIST, patternIssue } from './filament.ts'
import { stringFilter } from './listing.ts'
import {
  filamentJson,
  loadAll,
  sanitizeColor,
  sanitizeMultiColor,
  vendorJson,
} from './records.ts'
import { compileDatetimeFilter } from './spool.ts'
import {
  lastQueryValue,
  message,
  methodNotAllowed,
  respond,
  type LegacyApiModule,
} from './types.ts'
import { asBool, asInt, unprocessable, type Issue } from './validation.ts'

type HydratedFilament = SpoolFilament & { vendor: SpoolVendor | null }
interface Entry {
  key: string | null
  filament?: HydratedFilament
  vendor?: SpoolVendor | null
  spools: Spool[]
  filaments: Set<number>
}

const remaining = (spool: Spool, filament: SpoolFilament) => {
  const base = spool.initialWeight ?? filament.weight
  return base === null ? null : Math.max(base - spool.usedWeight, 0)
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Decoded text/choice value of a spool extra field, `null` when unset. */
function extraText(spool: Spool, key: string): string | null {
  const raw = spool.extra[key]
  if (typeof raw !== 'string') return null
  try {
    const value: unknown = JSON.parse(raw)
    return typeof value === 'string' ? value : null
  } catch {
    return null
  }
}

export const groupModule: LegacyApiModule = {
  name: 'spool-group',
  async handle(repo, request) {
    if (request.apiPath !== '/api/v1/spool/group') return undefined
    if (request.method !== 'GET') return methodNotAllowed()
    const q = (key: string) => lastQueryValue(request.query, key)
    const issues: Issue[] = []
    const groupBy = q('group_by')
    if (groupBy === null)
      issues.push({
        type: 'missing',
        loc: ['query', 'group_by'],
        msg: 'Field required',
        input: null,
      })
    for (const key of ['filament.id', 'filament.vendor.id']) {
      const value = q(key)
      if (value !== null && !ID_LIST.test(value))
        issues.push(patternIssue(key, value))
    }
    const flag = (key: string) => {
      const raw = q(key)
      if (raw === null) return false
      const parsed = asBool(['query', key], raw)
      if (parsed.ok) return parsed.value
      issues.push(parsed.issue)
      return false
    }
    const allowArchived = flag('allow_archived')
    const includeEmpty = flag('include_empty')
    const preview = flag('preview')
    let limit: number | null = null
    let offset = 0
    const rawLimit = q('limit')
    if (rawLimit !== null) {
      const parsed = asInt(['query', 'limit'], rawLimit)
      if (parsed.ok) limit = parsed.value
      else issues.push(parsed.issue)
    }
    const rawOffset = q('offset')
    if (rawOffset !== null) {
      const parsed = asInt(['query', 'offset'], rawOffset)
      if (parsed.ok) offset = parsed.value
      else issues.push(parsed.issue)
    }
    if (issues.length || groupBy === null) return unprocessable(issues)

    let byFirstUsed, byLastUsed, byRegistered
    try {
      byFirstUsed = compileDatetimeFilter(q('first_used'), 'first_used')
      byLastUsed = compileDatetimeFilter(q('last_used'), 'last_used')
      byRegistered = compileDatetimeFilter(q('registered'), 'registered')
    } catch (error) {
      return message(400, (error as Error).message)
    }

    const axis = groupBy.startsWith('extra.') ? 'extra' : groupBy
    if (!['filament', 'vendor', 'material', 'location', 'extra'].includes(axis))
      return message(
        400,
        `Invalid group_by '${groupBy}', expected filament, vendor, material, location or extra.<key>.`,
      )
    const extraKey = axis === 'extra' ? groupBy.slice(6) : null
    if (extraKey !== null) {
      const defs = await repo.extraFields.list('spool')
      if (!defs.ok) return defs
      const def = defs.value.find((f) => f.key === extraKey)
      if (
        !def ||
        !(
          def.fieldType === 'text' ||
          (def.fieldType === 'choice' && !def.multiChoice)
        )
      )
        return message(
          400,
          `Cannot group by '${groupBy}': only text and single-choice spool extra fields can be grouped.`,
        )
    }
    const spoolFilters = [
      'location',
      'lot_nr',
      'first_used',
      'last_used',
      'registered',
    ].filter((key) => q(key) !== null)
    if (includeEmpty && spoolFilters.length)
      return message(
        400,
        `include_empty cannot be combined with filters on spools themselves (${spoolFilters.join(', ')}).`,
      )

    const vendors = await loadAll((page) => repo.vendors.list(page))
    if (!vendors.ok) return vendors
    const filaments = await loadAll((page) => repo.filaments.list(page))
    if (!filaments.ok) return filaments
    const spools = await loadAll((page) => repo.spools.list(page))
    if (!spools.ok) return spools
    const vendorById = new Map(vendors.value.map((v) => [v.id, v]))
    const hydrated = new Map<number, HydratedFilament>(
      filaments.value.map((f) => [
        f.id,
        {
          ...f,
          vendor:
            f.vendorId === null ? null : (vendorById.get(f.vendorId) ?? null),
        },
      ]),
    )

    const filamentIds = q('filament.id')?.split(',').map(Number) ?? null
    const vendorIds = q('filament.vendor.id')?.split(',').map(Number) ?? null
    const byVendorName = stringFilter(q('filament.vendor.name'), false)
    const byName = stringFilter(q('filament.name'), true)
    const byMaterial = stringFilter(q('filament.material'), true)
    const byDirection = stringFilter(q('filament.multi_color_direction'), true)
    const byLocation = stringFilter(q('location'), true)
    const byLot = stringFilter(q('lot_nr'), true)
    const filamentMatches = (f: HydratedFilament) =>
      (!filamentIds || filamentIds.includes(f.id)) &&
      (!vendorIds ||
        vendorIds.some((id) =>
          id === -1 ? f.vendorId === null : f.vendorId === id,
        )) &&
      (!byVendorName || byVendorName(f.vendor?.name)) &&
      (!byName || byName(f.name)) &&
      (!byMaterial || byMaterial(f.material)) &&
      (!byDirection || byDirection(f.multiColorDirection))

    const entries = new Map<string, Entry>()
    const entryFor = (key: string | null, seed: Partial<Entry>): Entry => {
      const id = key === null ? '\0null' : `k:${key}`
      let entry = entries.get(id)
      if (!entry) {
        entry = { key, spools: [], filaments: new Set(), ...seed }
        entries.set(id, entry)
      }
      return entry
    }

    for (const spool of spools.value) {
      const filament = hydrated.get(spool.filamentId)
      if (
        !filament ||
        (spool.archived && !allowArchived) ||
        !filamentMatches(filament) ||
        (byLocation && !byLocation(spool.location)) ||
        (byLot && !byLot(spool.lotNr)) ||
        (byFirstUsed && !byFirstUsed(spool.firstUsedAt)) ||
        (byLastUsed && !byLastUsed(spool.lastUsedAt)) ||
        (byRegistered && !byRegistered(spool.registeredAt))
      )
        continue
      const entry =
        axis === 'filament'
          ? entryFor(String(filament.id), { filament })
          : axis === 'vendor'
            ? entryFor(
                filament.vendorId === null ? null : String(filament.vendorId),
                { vendor: filament.vendor },
              )
            : axis === 'material'
              ? entryFor(filament.material, {})
              : axis === 'location'
                ? entryFor(spool.location, {})
                : entryFor(extraText(spool, extraKey!), {})
      entry.spools.push(spool)
      entry.filaments.add(filament.id)
    }

    if (includeEmpty && axis === 'filament')
      for (const filament of hydrated.values())
        if (filamentMatches(filament))
          entryFor(String(filament.id), { filament })
    if (includeEmpty && axis === 'vendor')
      for (const filament of hydrated.values())
        if (
          filament.vendorId !== null &&
          filament.vendor &&
          filamentMatches(filament)
        ) {
          const entry = entryFor(String(filament.vendorId), {
            vendor: filament.vendor,
          })
          entry.filaments.add(filament.id)
        }

    const total = (entry: Entry) =>
      entry.spools.reduce<number | null>((sum, spool) => {
        const left = remaining(spool, hydrated.get(spool.filamentId)!)
        return left === null ? sum : (sum ?? 0) + left
      }, null)
    const lastUsed = (entry: Entry) =>
      entry.spools.reduce<number | null>(
        (best, s) =>
          s.lastUsedAt !== null && (best === null || s.lastUsedAt > best)
            ? s.lastUsedAt
            : best,
        null,
      )
    const title = (entry: Entry) =>
      axis === 'filament'
        ? (entry.filament?.name ?? '')
        : axis === 'vendor'
          ? (entry.vendor?.name ?? null)
          : entry.key

    const sortKeys: {
      get: (e: Entry) => string | number | null
      desc: boolean
    }[] = []
    for (const raw of (q('sort') ?? '').split(',')) {
      const [name = '', direction = 'asc'] = raw.trim().split(':')
      const desc = direction.trim().toLowerCase() === 'desc'
      const getters: Record<string, (e: Entry) => string | number | null> = {
        'group.title': title,
        'group.vendor_name': (e) =>
          e.vendor?.name ?? e.filament?.vendor?.name ?? null,
        'group.total_remaining': total,
        'group.last_used': lastUsed,
        'group.spool_count': (e) => e.spools.length,
        'group.in_use_count': (e) =>
          e.spools.filter((s) => s.usedWeight > 0).length,
        'group.filament_count': (e) => e.filaments.size,
        'filament.name': (e) => e.filament?.name ?? null,
        'filament.material': (e) => e.filament?.material ?? null,
        'filament.vendor.name': (e) => e.filament?.vendor?.name ?? null,
      }
      const get = Object.hasOwn(getters, name) ? getters[name] : undefined
      if (get) sortKeys.push({ get, desc })
    }
    sortKeys.push({ get: title, desc: false })
    const ordered = [...entries.values()].sort((a, b) => {
      for (const { get, desc } of sortKeys) {
        const x = get(a)
        const y = get(b)
        if (x === null || y === null) {
          if (x !== y) return x === null ? 1 : -1
          continue
        }
        const d =
          typeof x === 'number' && typeof y === 'number'
            ? x - y
            : compare(String(x), String(y))
        if (d !== 0) return desc ? -d : d
      }
      return 0
    })

    const totalSpools = ordered.reduce((n, e) => n + e.spools.length, 0)
    const totalRemaining = ordered.reduce((n, e) => n + (total(e) ?? 0), 0)
    const start = Math.max(0, offset)
    const page =
      limit === null
        ? ordered
        : limit < 0
          ? ordered.slice(start)
          : ordered.slice(start, start + limit)

    const body = page.map((entry) => {
      const sum = total(entry)
      const last = lastUsed(entry)
      const out: Record<string, unknown> = {
        group_by: groupBy,
        key: entry.key,
        spool_count: entry.spools.length,
        in_use_count: entry.spools.filter((s) => s.usedWeight > 0).length,
      }
      if (sum !== null) out['total_remaining_weight'] = sum
      if (last !== null) out['last_used'] = spoolmanDateTime(last)
      if (axis === 'filament' && entry.filament)
        out['filament'] = filamentJson(entry.filament, entry.filament.vendor)
      if (axis === 'vendor' && entry.vendor) {
        out['vendor'] = vendorJson(entry.vendor)
        out['filament_count'] = entry.filaments.size
      }
      if (preview && axis === 'filament' && entry.filament) {
        const filament = entry.filament
        out['spools'] = [...entry.spools]
          .sort((a, b) => a.id - b.id)
          .slice(0, 5)
          .map((s) =>
            Object.fromEntries(
              Object.entries({
                id: s.id,
                remaining_weight: remaining(s, filament),
                initial_weight: s.initialWeight ?? filament.weight,
              }).filter(([, v]) => v !== null),
            ),
          )
      }
      if (preview && axis === 'vendor' && entry.key !== null) {
        const vendorId = Number(entry.key)
        out['filaments'] = [...hydrated.values()]
          .filter((f) => f.vendorId === vendorId && filamentMatches(f))
          .sort((a, b) => compare(a.name ?? '', b.name ?? '') || a.id - b.id)
          .slice(0, 4)
          .map((f) =>
            Object.fromEntries(
              Object.entries({
                id: f.id,
                color_hex: sanitizeColor(f.colorHex),
                multi_color_hexes: sanitizeMultiColor(f.multiColorHexes),
                multi_color_direction: f.multiColorDirection,
              }).filter(([, v]) => v !== null),
            ),
          )
      }
      return out
    })
    return respond(200, body, {
      'x-total-count': String(ordered.length),
      'x-total-spools': String(totalSpools),
      'x-total-remaining-weight': String(totalRemaining),
    })
  },
}
