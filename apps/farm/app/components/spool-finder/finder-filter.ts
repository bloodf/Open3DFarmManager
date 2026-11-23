import type { SpoolItem } from '../../utils/spool-library-types.ts'

export interface FinderFilters {
  /** Free text: id (`#12`), name, vendor, article number, lot or comment. */
  text: string
  /** Exact material, for example `PLA`; empty for any. */
  material: string
  /** Part of a location; empty for any. */
  location: string
  /** Only spools with no location recorded. */
  withoutLocation: boolean
  /** A `#RRGGBB` value or a colour name in Portuguese; empty for any. */
  color: string
  includeArchived: boolean
}

export const EMPTY_FINDER_FILTERS: FinderFilters = {
  text: '',
  material: '',
  location: '',
  withoutLocation: false,
  color: '',
  includeArchived: false,
}

/** Colour names an operator can type, as sRGB values. */
export const COLOR_NAMES: Readonly<Record<string, string>> = {
  preto: '000000',
  branco: 'FFFFFF',
  cinza: '808080',
  vermelho: 'E02020',
  laranja: 'FF8000',
  amarelo: 'FFD800',
  verde: '1FA050',
  azul: '1F4FE0',
  roxo: '7A2FC0',
  rosa: 'FF69B4',
  marrom: '7A4A21',
}

/** Largest RGB distance (0–441) at which two colours count as the same. */
export const COLOR_TOLERANCE = 72

export function normalizeText(value: string): string {
  return value
    .toLocaleLowerCase('pt-BR')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .trim()
}

function hexToRgb(hex: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return null
  const value = parseInt(match[1]!, 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

/** The colour a search term stands for, or null when it is not a colour. */
export function searchColor(term: string): [number, number, number] | null {
  const key = normalizeText(term)
  const named = COLOR_NAMES[key]
  return hexToRgb(named ?? term)
}

function spoolColors(spool: SpoolItem): [number, number, number][] {
  const raw = [
    ...(spool.filament.multi_color_hexes?.split(',') ?? []),
    ...(spool.filament.color_hex ? [spool.filament.color_hex] : []),
  ]
  return raw.flatMap((hex) => {
    const rgb = hexToRgb(hex)
    return rgb ? [rgb] : []
  })
}

function colorMatches(spool: SpoolItem, term: string): boolean {
  const wanted = searchColor(term)
  if (!wanted)
    return normalizeText(spool.filament.name ?? '').includes(
      normalizeText(term),
    )
  return spoolColors(spool).some(
    (rgb) =>
      Math.hypot(rgb[0] - wanted[0], rgb[1] - wanted[1], rgb[2] - wanted[2]) <=
      COLOR_TOLERANCE,
  )
}

function textOf(spool: SpoolItem): string {
  const { filament } = spool
  return normalizeText(
    [
      `#${spool.id}`,
      String(spool.id),
      filament.name,
      filament.material,
      filament.vendor?.name,
      filament.article_number,
      spool.lot_nr,
      spool.comment,
      spool.location,
    ]
      .filter((part): part is string => typeof part === 'string')
      .join(' '),
  )
}

export function filterSpools(
  spools: readonly SpoolItem[],
  filters: FinderFilters,
): SpoolItem[] {
  const text = normalizeText(filters.text)
  const material = normalizeText(filters.material)
  const location = normalizeText(filters.location)
  const color = filters.color.trim()
  return spools.filter((spool) => {
    if (spool.archived && !filters.includeArchived) return false
    if (material && normalizeText(spool.filament.material ?? '') !== material)
      return false
    if (filters.withoutLocation && spool.location?.trim()) return false
    if (location && !normalizeText(spool.location ?? '').includes(location))
      return false
    if (color && !colorMatches(spool, color)) return false
    if (text && !textOf(spool).includes(text)) return false
    return true
  })
}

export function distinctValues(
  values: readonly (string | undefined)[],
): string[] {
  return [
    ...new Set(
      values.filter((v): v is string => typeof v === 'string' && !!v.trim()),
    ),
  ].sort((a, b) => a.localeCompare(b, 'pt-BR'))
}
