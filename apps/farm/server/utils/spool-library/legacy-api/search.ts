/**
 * `GET /api/v1/search` of the pinned Spoolman v0.27.1: one query across this
 * farm's spools, filaments and vendors. Terms are split on whitespace; an
 * entity matches when every term is found case-insensitively in one of its
 * text fields (or text/choice extra fields, or a filament's vendor name).
 * A hex code (`#ff0000`) also runs the color-similarity search over filaments.
 */
import type { Spool, SpoolFilament, SpoolVendor } from '../scope.ts'
import { escapeLike, sqliteLike } from './compat.ts'
import { deltaE, hexToRgb, rgbToLab, similarColorIds } from './color.ts'
import { CSS_COLORS } from './css-colors.ts'
import {
  extraOf,
  filamentJson,
  loadAll,
  spoolJson,
  vendorJson,
} from './records.ts'
import {
  lastQueryValue,
  methodNotAllowed,
  respond,
  type LegacyApiModule,
} from './types.ts'
import { tooShort } from './aux-common.ts'
import {
  asBool,
  asFloat,
  asInt,
  unprocessable,
  type Issue,
} from './validation.ts'

/** Upstream rank buckets: lower sorts first, a substring hit ranks one worse. */
/** Upstream `resolve_color`: a hex code or CSS color name as `RRGGBB`. */
function resolveColor(query: string): string | null {
  const normalized = query.trim().toLowerCase().replaceAll(' ', '')
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(normalized)
  if (hex) {
    const digits = hex[1]!
    return digits.length === 3 ? [...digits].map((c) => c + c).join('') : digits
  }
  return Object.hasOwn(CSS_COLORS, normalized) ? CSS_COLORS[normalized]! : null
}

const RANK_ID_OR_COLOR = -1
const BASE_NATIVE = 0
const BASE_VENDOR = 2
const BASE_EXTRA = 4
const WEAK_PENALTY = 1
/** Candidate rows ranked per entity (newest first), and terms honoured. */
const CANDIDATE_CAP = 200
const MAX_TERMS = 8

/** `(label, value, base rank)` as upstream's `_classify_match` takes them. */
type Field = readonly [
  label: string,
  value: string | null | undefined,
  base: number,
]

const splitTerms = (q: string): string[] => {
  const terms: string[] = []
  for (const raw of q.toLowerCase().split(/\s+/u).filter(Boolean))
    if (!terms.includes(raw)) terms.push(raw)
  return terms.slice(0, MAX_TERMS)
}

/** SQL `ilike '%term%' escape '/'` on SQLite: ASCII case-insensitive. */
const ilike = (value: string | null | undefined, term: string) =>
  !!value && sqliteLike(value, `%${escapeLike(term)}%`, '/')

/**
 * `(match_field, rank)` when every term is found in some field: the field is
 * the best hit across terms, the rank the worst term's rank.
 */
function classify(
  terms: readonly string[],
  fields: readonly Field[],
): { field: string; rank: number } | null {
  let best: { field: string; rank: number } | null = null
  let worst = RANK_ID_OR_COLOR
  for (const term of terms) {
    let termBest: { field: string; rank: number } | null = null
    for (const [label, value, base] of fields) {
      if (!value) continue
      const lowered = value.toLowerCase()
      if (!lowered.includes(term)) continue
      const rank = lowered.startsWith(term) ? base : base + WEAK_PENALTY
      if (termBest === null || rank < termBest.rank)
        termBest = { field: label, rank }
    }
    if (termBest === null) return null
    worst = Math.max(worst, termBest.rank)
    if (best === null || termBest.rank < best.rank) best = termBest
  }
  return best ? { field: best.field, rank: worst } : null
}

/** Stored (JSON text) values of the text and choice extra fields. */
function extraFields(
  extra: Record<string, unknown>,
  keys: ReadonlySet<string>,
): Field[] {
  const out: Field[] = []
  for (const [key, value] of Object.entries(extraOf(extra)).sort(([x], [y]) =>
    x < y ? -1 : x > y ? 1 : 0,
  ))
    if (keys.has(key)) out.push([`extra.${key}`, value, BASE_EXTRA])
  return out
}

/** Every term appears in a native column, the extra values or `more`. */
const everyTermHits = (
  terms: readonly string[],
  columns: readonly (string | null | undefined)[],
  extra: Record<string, unknown>,
  keys: ReadonlySet<string>,
) =>
  terms.every(
    (term) =>
      columns.some((value) => ilike(value, term)) ||
      extraFields(extra, keys).some(([, value]) => ilike(value, term)),
  )

const remaining = (
  weight: number | null,
  used: number,
  filament: SpoolFilament,
) => {
  const base = weight ?? filament.weight
  return base === null ? null : Math.max(base - used, 0)
}

const present = (entries: [string, unknown][]) =>
  Object.fromEntries(entries.filter(([, v]) => v !== null && v !== undefined))

export const searchModule: LegacyApiModule = {
  name: 'search',
  async handle(repo, request) {
    if (request.apiPath !== '/api/v1/search') return undefined
    if (request.method !== 'GET') return methodNotAllowed()
    const issues: Issue[] = []
    const q = lastQueryValue(request.query, 'q')
    if (q === null)
      issues.push({
        type: 'missing',
        loc: ['query', 'q'],
        msg: 'Field required',
        input: null,
      })
    else if (q.length < 1) issues.push(tooShort(['query', 'q'], q))
    const number = <T extends number>(
      key: string,
      fallback: T,
      parse: typeof asInt | typeof asFloat,
      min: number,
      max: number,
    ): number => {
      const raw = lastQueryValue(request.query, key)
      if (raw === null) return fallback
      const parsed = parse(['query', key], raw)
      if (!parsed.ok) {
        issues.push(parsed.issue)
        return fallback
      }
      if (parsed.value < min)
        issues.push({
          type: 'greater_than_equal',
          loc: ['query', key],
          msg: `Input should be greater than or equal to ${min}`,
          input: raw,
          ctx: { ge: min },
        })
      else if (parsed.value > max)
        issues.push({
          type: 'less_than_equal',
          loc: ['query', key],
          msg: `Input should be less than or equal to ${max}`,
          input: raw,
          ctx: { le: max },
        })
      return parsed.value
    }
    const threshold = number('color_similarity_threshold', 20, asFloat, 0, 100)
    const limit = number('limit', 20, asInt, 1, 100)
    const perFilament = number('spools_per_filament', 0, asInt, 0, 10)
    let allowArchived = false
    const rawArchived = lastQueryValue(request.query, 'allow_archived')
    if (rawArchived !== null) {
      const parsed = asBool(['query', 'allow_archived'], rawArchived)
      if (parsed.ok) allowArchived = parsed.value
      else issues.push(parsed.issue)
    }
    if (issues.length || q === null) return unprocessable(issues)

    const terms = splitTerms(q.trim())
    if (terms.length === 0)
      return respond(200, {
        spools: [],
        filaments: [],
        vendors: [],
        is_color_query: false,
      })
    const vendors = await loadAll((page) => repo.vendors.list(page))
    if (!vendors.ok) return vendors
    const filaments = await loadAll((page) => repo.filaments.list(page))
    if (!filaments.ok) return filaments
    const spools = await loadAll((page) => repo.spools.list(page))
    if (!spools.ok) return spools
    const textKeys = async (entity: 'vendor' | 'filament' | 'spool') => {
      const defs = await repo.extraFields.list(entity)
      return defs.ok
        ? ({
            ok: true,
            value: new Set(
              defs.value
                .filter(
                  (d) => d.fieldType === 'text' || d.fieldType === 'choice',
                )
                .map((d) => d.key),
            ),
          } as const)
        : defs
    }
    const spoolKeys = await textKeys('spool')
    if (!spoolKeys.ok) return spoolKeys
    const filamentKeys = await textKeys('filament')
    if (!filamentKeys.ok) return filamentKeys
    const vendorKeys = await textKeys('vendor')
    if (!vendorKeys.ok) return vendorKeys
    const vendorById = new Map<number, SpoolVendor>(
      vendors.value.map((v) => [v.id, v]),
    )
    const filamentById = new Map(filaments.value.map((f) => [f.id, f]))
    const vendorOf = (f: SpoolFilament) =>
      f.vendorId === null ? null : (vendorById.get(f.vendorId) ?? null)
    const newestFirst = <T extends { id: number }>(rows: readonly T[]) =>
      [...rows].sort((x, y) => y.id - x.id).slice(0, CANDIDATE_CAP)
    const ordered = <T extends { id: number }>(
      hits: { row: T; field: string; rank: number; order?: number }[],
    ) =>
      hits
        .sort(
          (x, y) =>
            x.rank - y.rank ||
            (x.order ?? 0) - (y.order ?? 0) ||
            x.row.id - y.row.id,
        )
        .slice(0, limit)

    const spoolHits: { row: Spool; field: string; rank: number }[] = []
    for (const spool of newestFirst(
      spools.value.filter((s) => allowArchived || !s.archived),
    )) {
      if (
        !everyTermHits(
          terms,
          [spool.comment, spool.location, spool.lotNr],
          spool.extra,
          spoolKeys.value,
        )
      )
        continue
      const hit = classify(terms, [
        ['comment', spool.comment, BASE_NATIVE],
        ['location', spool.location, BASE_NATIVE],
        ['lot_nr', spool.lotNr, BASE_NATIVE],
        ...extraFields(spool.extra, spoolKeys.value),
      ])
      if (hit) spoolHits.push({ row: spool, field: hit.field, rank: hit.rank })
    }
    let spoolResults = ordered(spoolHits)

    const colorHex = resolveColor(q)
    const colorHits: {
      row: SpoolFilament
      field: string
      rank: number
      order: number
    }[] = []
    if (colorHex !== null) {
      const ids = similarColorIds(filaments.value, colorHex, threshold)
      const target = rgbToLab(hexToRgb(colorHex) ?? [0, 0, 0])
      const distance = (f: SpoolFilament) => {
        const colors =
          f.colorHex !== null
            ? [f.colorHex]
            : f.multiColorHexes !== null
              ? f.multiColorHexes.split(',')
              : []
        return colors.length === 0
          ? Infinity
          : Math.min(
              ...colors.map((c) =>
                deltaE(target, rgbToLab(hexToRgb(c) ?? [0, 0, 0])),
              ),
            )
      }
      const matched = filaments.value
        .filter((f) => ids?.has(f.id))
        .sort((x, y) => distance(x) - distance(y))
        .slice(0, limit)
      matched.forEach((row, order) =>
        colorHits.push({ row, field: 'color', rank: RANK_ID_OR_COLOR, order }),
      )
    }
    const claimed = new Set(colorHits.map((h) => h.row.id))
    const filamentHits = [...colorHits]
    for (const filament of newestFirst(filaments.value)) {
      if (claimed.has(filament.id)) continue
      const vendor = vendorOf(filament)
      if (
        !everyTermHits(
          terms,
          [
            filament.name,
            filament.material,
            filament.articleNumber,
            filament.comment,
            vendor?.name,
          ],
          filament.extra,
          filamentKeys.value,
        )
      )
        continue
      const hit = classify(terms, [
        ['name', filament.name, BASE_NATIVE],
        ['material', filament.material, BASE_NATIVE],
        ['article_number', filament.articleNumber, BASE_NATIVE],
        ['comment', filament.comment, BASE_NATIVE],
        ['vendor.name', vendor?.name, BASE_VENDOR],
        ...extraFields(filament.extra, filamentKeys.value),
      ])
      if (hit)
        filamentHits.push({
          row: filament,
          field: hit.field,
          rank: hit.rank,
          order: 0,
        })
    }

    const vendorHits: { row: SpoolVendor; field: string; rank: number }[] = []
    for (const vendor of newestFirst(vendors.value)) {
      if (
        !everyTermHits(
          terms,
          [vendor.name, vendor.comment],
          vendor.extra,
          vendorKeys.value,
        )
      )
        continue
      const hit = classify(terms, [
        ['name', vendor.name, BASE_NATIVE],
        ['comment', vendor.comment, BASE_NATIVE],
        ...extraFields(vendor.extra, vendorKeys.value),
      ])
      if (hit)
        vendorHits.push({ row: vendor, field: hit.field, rank: hit.rank })
    }

    const spoolsOf = (filament: SpoolFilament) =>
      spools.value
        .filter(
          (s) => s.filamentId === filament.id && (allowArchived || !s.archived),
        )
        .sort((a, b) => a.id - b.id)

    const filamentResults = ordered(filamentHits).map(({ row, field }) => {
      const own = perFilament > 0 ? spoolsOf(row) : []
      return present([
        ['filament', filamentJson(row, vendorOf(row))],
        ['match_field', field],
        [
          'spools',
          perFilament > 0
            ? own.slice(0, perFilament).map((s) =>
                present([
                  ['id', s.id],
                  [
                    'remaining_weight',
                    remaining(s.initialWeight, s.usedWeight, row),
                  ],
                  ['location', s.location],
                  ['archived', s.archived],
                ]),
              )
            : null,
        ],
        ['spool_count', perFilament > 0 ? own.length : null],
      ])
    })

    // A numeric query puts the spool with that exact id first.
    const trimmed = q.trim()
    if (/^[0-9]+$/.test(trimmed)) {
      const exact = spools.value.find((s) => s.id === Number(trimmed))
      if (exact && (allowArchived || !exact.archived))
        spoolResults = [
          { row: exact, field: 'id', rank: -1 },
          ...spoolResults.filter((h) => h.row.id !== exact.id),
        ].slice(0, limit)
    }

    return respond(200, {
      spools: spoolResults.flatMap(({ row, field }) => {
        const filament = filamentById.get(row.filamentId)
        return filament
          ? [
              {
                spool: spoolJson(row, filament, vendorOf(filament)),
                match_field: field,
              },
            ]
          : []
      }),
      filaments: filamentResults,
      vendors: ordered(vendorHits).map(({ row, field }) => ({
        vendor: vendorJson(row),
        match_field: field,
      })),
      is_color_query: colorHex !== null,
    })
  },
}
