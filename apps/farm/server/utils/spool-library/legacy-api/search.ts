/**
 * `GET /api/v1/search` of the pinned Spoolman v0.27.1: one query across this
 * farm's spools, filaments and vendors. Terms are split on whitespace; an
 * entity matches when every term is found case-insensitively in one of its
 * text fields (or text/choice extra fields, or a filament's vendor name).
 * A hex code (`#ff0000`) also runs the color-similarity search over filaments.
 */
import type { Spool, SpoolFilament, SpoolVendor } from '../scope.ts'
import { similarColorIds } from './color.ts'
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

type Candidate = [field: string, text: string | null | undefined]

/** Text of a text/choice extra value, `null` for anything else. */
function extraTexts(extra: Record<string, unknown>): Candidate[] {
  const out: Candidate[] = []
  for (const [key, raw] of Object.entries(extraOf(extra))) {
    try {
      const value: unknown = JSON.parse(raw)
      if (typeof value === 'string') out.push([`extra.${key}`, value])
      else if (
        Array.isArray(value) &&
        value.every((v) => typeof v === 'string')
      )
        out.push([`extra.${key}`, value.join(' ')])
    } catch {
      // Not JSON text: never a searchable value.
    }
  }
  return out
}

/** Field of the first term when every term matches somewhere, else `null`. */
function matchField(terms: readonly string[], candidates: Candidate[]) {
  const lowered = candidates.map(
    ([field, text]) => [field, (text ?? '').toLowerCase()] as const,
  )
  let first: string | null = null
  let rank = 2
  for (const [index, term] of terms.entries()) {
    const hit = lowered.find(([, text]) => text.includes(term))
    if (!hit) return null
    if (index === 0) {
      first = hit[0]
      rank = hit[1] === term ? 0 : hit[1].startsWith(term) ? 1 : 2
    }
  }
  return first === null ? null : { field: first, rank }
}

const remaining = (spool: Spool, filament: SpoolFilament) => {
  const base = spool.initialWeight ?? filament.weight
  return base === null ? null : Math.max(base - spool.usedWeight, 0)
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

    const terms = q.toLowerCase().split(/\s+/u).filter(Boolean)
    const vendors = await loadAll((page) => repo.vendors.list(page))
    if (!vendors.ok) return vendors
    const filaments = await loadAll((page) => repo.filaments.list(page))
    if (!filaments.ok) return filaments
    const spools = await loadAll((page) => repo.spools.list(page))
    if (!spools.ok) return spools
    const vendorById = new Map<number, SpoolVendor>(
      vendors.value.map((v) => [v.id, v]),
    )
    const filamentById = new Map(filaments.value.map((f) => [f.id, f]))
    const vendorOf = (f: SpoolFilament) =>
      f.vendorId === null ? null : (vendorById.get(f.vendorId) ?? null)

    const ranked = <T extends { id: number }>(
      rows: { row: T; field: string; rank: number }[],
    ) =>
      rows
        .sort((a, b) => a.rank - b.rank || a.row.id - b.row.id)
        .slice(0, limit)

    const spoolHits: { row: Spool; field: string; rank: number }[] = []
    const numeric = /^\d+$/.test(q.trim()) ? Number(q.trim()) : null
    for (const spool of spools.value) {
      if (spool.archived && !allowArchived) continue
      if (numeric !== null && spool.id === numeric) {
        spoolHits.push({ row: spool, field: 'id', rank: 0 })
        continue
      }
      const hit = matchField(terms, [
        ['comment', spool.comment],
        ['location', spool.location],
        ['lot_nr', spool.lotNr],
        ...extraTexts(spool.extra),
      ])
      if (hit) spoolHits.push({ row: spool, field: hit.field, rank: hit.rank })
    }

    const isColor = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(q.trim())
    const colorIds = isColor
      ? (similarColorIds(filaments.value, q.trim(), threshold) ??
        new Set<number>())
      : new Set<number>()
    const filamentHits: { row: SpoolFilament; field: string; rank: number }[] =
      []
    for (const filament of filaments.value) {
      const hit = matchField(terms, [
        ['name', filament.name],
        ['material', filament.material],
        ['article_number', filament.articleNumber],
        ['comment', filament.comment],
        ['external_id', filament.externalId],
        ...extraTexts(filament.extra),
        ['vendor.name', vendorOf(filament)?.name],
      ])
      if (hit)
        filamentHits.push({ row: filament, field: hit.field, rank: hit.rank })
      else if (colorIds.has(filament.id))
        filamentHits.push({ row: filament, field: 'color', rank: 3 })
    }

    const vendorHits: { row: SpoolVendor; field: string; rank: number }[] = []
    for (const vendor of vendors.value) {
      const hit = matchField(terms, [
        ['name', vendor.name],
        ['comment', vendor.comment],
        ...extraTexts(vendor.extra),
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

    return respond(200, {
      spools: ranked(spoolHits).flatMap(({ row, field }) => {
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
      filaments: ranked(filamentHits).map(({ row, field }) => {
        const own = perFilament > 0 ? spoolsOf(row) : []
        return present([
          ['filament', filamentJson(row, vendorOf(row))],
          ['match_field', field],
          ['spool_count', perFilament > 0 ? own.length : null],
          [
            'spools',
            perFilament > 0
              ? own.slice(0, perFilament).map((s) =>
                  present([
                    ['id', s.id],
                    ['archived', s.archived],
                    ['location', s.location],
                    ['remaining_weight', remaining(s, row)],
                  ]),
                )
              : null,
          ],
        ])
      }),
      vendors: ranked(vendorHits).map(({ row, field }) => ({
        vendor: vendorJson(row),
        match_field: field,
      })),
      is_color_query: isColor,
    })
  },
}
