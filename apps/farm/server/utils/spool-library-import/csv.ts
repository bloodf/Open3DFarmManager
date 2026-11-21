/**
 * CSV import input. Understands the flattened layout of Spoolman's CSV export:
 * dotted headers (`filament.vendor.name`, `extra.shelf`) become nested objects
 * the bundle normalizer already accepts. One CSV carries one entity kind.
 */
import type { BundleProblem } from './bundle.ts'

export type CsvEntity = 'vendors' | 'filaments' | 'spools'
const MAX_COLUMNS = 80
const MAX_ROWS = 50_000
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype'])

type Parsed = { ok: true; rows: string[][] } | { ok: false; problem: string }

/** RFC 4180 reader: quoted fields, doubled quotes, CRLF or LF, optional BOM. */
export function parseCsv(input: string): Parsed {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let touched = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') ((field += '"'), i++)
        else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"' && field === '') ((quoted = true), (touched = true))
    else if (ch === ',') {
      row.push(field)
      field = ''
      touched = true
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      if (touched || field !== '') row.push(field)
      if (row.length > 0) rows.push(row)
      if (rows.length > MAX_ROWS + 1)
        return { ok: false, problem: `at most ${MAX_ROWS} rows are accepted` }
      row = []
      field = ''
      touched = false
    } else field += ch
  }
  if (quoted) return { ok: false, problem: 'unterminated quoted field' }
  if (touched || field !== '') row.push(field)
  if (row.length > 0) rows.push(row)
  return { ok: true, rows }
}

function assign(
  target: Record<string, unknown>,
  path: string[],
  value: string,
) {
  let node = target
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i] as string
    const next = node[key]
    if (typeof next === 'object' && next !== null)
      node = next as Record<string, unknown>
    else {
      const created: Record<string, unknown> = {}
      node[key] = created
      node = created
    }
  }
  node[path[path.length - 1] as string] = value
}

/** Returns the object `normalizeBundle` expects, or the first problems found. */
export function csvToBundleInput(
  entity: CsvEntity,
  text: string,
):
  | { ok: true; input: Record<string, unknown> }
  | { ok: false; problems: BundleProblem[] } {
  const parsed = parseCsv(text)
  if (!parsed.ok)
    return { ok: false, problems: [{ path: 'csv', problem: parsed.problem }] }
  const [header, ...body] = parsed.rows
  if (!header)
    return {
      ok: false,
      problems: [{ path: 'csv', problem: 'header row is required' }],
    }
  if (header.length > MAX_COLUMNS)
    return {
      ok: false,
      problems: [
        { path: 'csv', problem: `at most ${MAX_COLUMNS} columns are accepted` },
      ],
    }
  const paths = header.map((h) => h.trim().split('.'))
  const seen = new Set<string>()
  for (const [i, path] of paths.entries()) {
    const name = header[i]!.trim()
    if (path.some((s) => s === '' || FORBIDDEN.has(s)) || seen.has(name))
      return {
        ok: false,
        problems: [
          { path: `csv.header[${i}]`, problem: 'invalid or duplicate column' },
        ],
      }
    seen.add(name)
  }
  if (!seen.has('id'))
    return {
      ok: false,
      problems: [
        {
          path: 'csv.header',
          problem: 'an id column is required for a stable source identity',
        },
      ],
    }
  const records: Record<string, unknown>[] = []
  for (const [r, cells] of body.entries()) {
    if (cells.length > header.length)
      return {
        ok: false,
        problems: [
          { path: `csv.row[${r + 1}]`, problem: 'more cells than columns' },
        ],
      }
    const record: Record<string, unknown> = {}
    for (const [i, path] of paths.entries()) {
      const value = cells[i] ?? ''
      if (value !== '') assign(record, path, value)
    }
    records.push(record)
  }
  return { ok: true, input: { [entity]: records } }
}
