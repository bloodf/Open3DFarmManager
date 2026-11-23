import { formatDateTime, formatNumber, formatWeight } from './ui-format.ts'
import type {
  BundleProblem,
  FilamentFilters,
  FilamentItem,
  ImportCollisionPolicy,
  ImportConflictPolicy,
  ImportCsvEntity,
  ImportFormat,
  ImportReport,
  SpoolFilters,
  SpoolItem,
  VendorFilters,
  VendorItem,
} from './spool-library-types.ts'

const HEX_COLOR = /^[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/
const SOURCE_KEY = /^[a-z0-9][a-z0-9._:-]{0,95}$/

export const EMPTY_SPOOL_FILTERS: SpoolFilters = {
  q: '',
  material: '',
  vendorId: '',
  location: '',
  allowArchived: false,
  sort: 'id:desc',
}

export const EMPTY_FILAMENT_FILTERS: FilamentFilters = {
  q: '',
  material: '',
  vendorId: '',
  sort: 'id:desc',
}

export const EMPTY_VENDOR_FILTERS: VendorFilters = {
  q: '',
  sort: 'name:asc',
}

export const SPOOL_SORT_OPTIONS = [
  { value: 'id:desc', label: 'Mais recentes (ID)' },
  { value: 'id:asc', label: 'Mais antigas (ID)' },
  { value: 'remaining_weight:asc', label: 'Menor peso restante' },
  { value: 'remaining_weight:desc', label: 'Maior peso restante' },
  { value: 'filament.combined_name:asc', label: 'Filamento (A–Z)' },
  { value: 'filament.material:asc', label: 'Material (A–Z)' },
  { value: 'location:asc', label: 'Localização (A–Z)' },
  { value: 'last_used:desc', label: 'Último uso' },
] as const

export const FILAMENT_SORT_OPTIONS = [
  { value: 'id:desc', label: 'Mais recentes (ID)' },
  { value: 'name:asc', label: 'Nome (A–Z)' },
  { value: 'material:asc', label: 'Material (A–Z)' },
  { value: 'vendor.name:asc', label: 'Fornecedor (A–Z)' },
  { value: 'weight:desc', label: 'Maior peso líquido' },
  { value: 'price:asc', label: 'Menor preço' },
] as const

export const VENDOR_SORT_OPTIONS = [
  { value: 'name:asc', label: 'Nome (A–Z)' },
  { value: 'name:desc', label: 'Nome (Z–A)' },
  { value: 'id:desc', label: 'Mais recentes (ID)' },
  { value: 'empty_spool_weight:asc', label: 'Peso do carretel vazio' },
] as const

export function normalizeColorHex(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null
  const cleaned = raw.trim().replace(/^#/, '').toUpperCase()
  return HEX_COLOR.test(cleaned) ? cleaned : null
}

export function parseMultiColorHexes(raw: string | null | undefined): string[] {
  if (!raw) return []
  const parts = raw
    .split(',')
    .map((part) => normalizeColorHex(part))
    .filter((value): value is string => value !== null)
  return parts.length >= 2 ? parts : []
}

export function filamentSwatchBackground(
  filament: Pick<
    FilamentItem,
    'color_hex' | 'multi_color_hexes' | 'multi_color_direction'
  >,
): string | null {
  const multi = parseMultiColorHexes(filament.multi_color_hexes)
  if (multi.length >= 2) {
    const stops = multi.map((hex) => `#${hex}`).join(', ')
    const angle =
      filament.multi_color_direction === 'coaxial' ? '90deg' : '180deg'
    return `linear-gradient(${angle}, ${stops})`
  }
  const single = normalizeColorHex(filament.color_hex)
  return single ? `#${single}` : null
}

export function filamentColorLabel(
  filament: Pick<
    FilamentItem,
    'color_hex' | 'multi_color_hexes' | 'multi_color_direction'
  >,
): string {
  const multi = parseMultiColorHexes(filament.multi_color_hexes)
  if (multi.length >= 2) {
    const dir =
      filament.multi_color_direction === 'coaxial' ? 'coaxial' : 'longitudinal'
    return `${multi.map((c) => `#${c}`).join(', ')} (${dir})`
  }
  const single = normalizeColorHex(filament.color_hex)
  return single ? `#${single}` : 'Sem cor'
}

export function filamentDisplayTitle(filament: FilamentItem): string {
  const name = filament.name?.trim()
  const vendor = filament.vendor?.name?.trim()
  if (vendor && name) return `${vendor} · ${name}`
  if (name) return name
  if (vendor && filament.material) return `${vendor} · ${filament.material}`
  if (filament.material) return `${filament.material} #${filament.id}`
  return `Filamento #${filament.id}`
}

export function spoolDisplayTitle(spool: SpoolItem): string {
  return filamentDisplayTitle(spool.filament)
}

export function spoolBaseWeight(spool: SpoolItem): number | null {
  if (spool.initial_weight !== undefined && spool.initial_weight !== null)
    return spool.initial_weight
  if (spool.filament.weight !== undefined && spool.filament.weight !== null)
    return spool.filament.weight
  return null
}

export function spoolTareWeight(spool: SpoolItem): number | null {
  if (spool.spool_weight !== undefined && spool.spool_weight !== null)
    return spool.spool_weight
  if (
    spool.filament.spool_weight !== undefined &&
    spool.filament.spool_weight !== null
  )
    return spool.filament.spool_weight
  if (
    spool.filament.vendor?.empty_spool_weight !== undefined &&
    spool.filament.vendor?.empty_spool_weight !== null
  )
    return spool.filament.vendor.empty_spool_weight
  return null
}

export function spoolRemainingPercent(spool: SpoolItem): number | null {
  const base = spoolBaseWeight(spool)
  const remaining = spool.remaining_weight
  if (
    base === null ||
    base <= 0 ||
    remaining === undefined ||
    remaining === null
  )
    return null
  const pct = (remaining / base) * 100
  return Math.max(0, Math.min(100, Math.round(pct)))
}

export function formatSpoolWeight(grams: number | null | undefined): string {
  if (grams === null || grams === undefined || !Number.isFinite(grams))
    return '—'
  const abs = formatWeight(Math.abs(grams))
  if (!abs) return '—'
  return grams < 0 ? `-${abs}` : abs
}

export function formatSpoolLength(mm: number | null | undefined): string {
  if (mm === null || mm === undefined || !Number.isFinite(mm)) return '—'
  const meters = mm / 1000
  return `${formatNumber(meters, { maximumFractionDigits: 1 })} m`
}

export function formatPrice(price: number | null | undefined): string {
  if (price === null || price === undefined || !Number.isFinite(price))
    return '—'
  return formatNumber(price, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

export function formatIsoDate(value: string | null | undefined): string {
  if (!value) return '—'
  return formatDateTime(value, 'short') ?? '—'
}

export function weightFromLengthMm(
  lengthMm: number,
  diameterMm: number,
  densityGcm3: number,
): number {
  const volumeMm3 = lengthMm * Math.PI * (diameterMm / 2) ** 2
  return densityGcm3 * (volumeMm3 / 1000)
}

export function estimateAfterUse(
  spool: SpoolItem,
  unit: 'weight' | 'length',
  amount: number,
): { deltaGrams: number; nextRemaining: number | null } | null {
  if (!Number.isFinite(amount) || amount === 0) return null
  const deltaGrams =
    unit === 'weight'
      ? amount
      : weightFromLengthMm(
          amount,
          spool.filament.diameter,
          spool.filament.density,
        )
  const base = spoolBaseWeight(spool)
  const nextUsed = spool.used_weight + deltaGrams
  const nextRemaining = base === null ? null : Math.max(base - nextUsed, 0)
  return { deltaGrams, nextRemaining }
}

export function estimateAfterMeasure(
  spool: SpoolItem,
  grossWeight: number,
): { nextRemaining: number; tare: number } | { error: string } {
  if (!Number.isFinite(grossWeight) || grossWeight < 0)
    return { error: 'Informe um peso válido em gramas.' }
  const initial = spoolBaseWeight(spool)
  if (initial === null || initial <= 0) {
    return {
      error:
        'Defina o peso inicial da bobina ou do filamento antes de registrar a pesagem.',
    }
  }
  const tare = spoolTareWeight(spool) ?? 0
  const nextRemaining = Math.max(grossWeight - tare, 0)
  return { nextRemaining, tare }
}

export function buildSpoolQuery(
  filters: SpoolFilters,
): Record<string, string | boolean> {
  const query: Record<string, string | boolean> = {}
  if (filters.q.trim()) query.q = filters.q.trim()
  if (filters.material.trim()) query.filament_material = filters.material.trim()
  if (filters.vendorId.trim()) query.vendor_id = filters.vendorId.trim()
  if (filters.location.trim()) query.location = filters.location.trim()
  if (filters.allowArchived) query.allow_archived = true
  if (filters.sort.trim()) query.sort = filters.sort.trim()
  return query
}

export function buildFilamentQuery(
  filters: FilamentFilters,
): Record<string, string> {
  const query: Record<string, string> = {}
  if (filters.q.trim()) query.q = filters.q.trim()
  if (filters.material.trim()) query.material = filters.material.trim()
  if (filters.vendorId.trim()) query.vendor_id = filters.vendorId.trim()
  if (filters.sort.trim()) query.sort = filters.sort.trim()
  return query
}

export function buildVendorQuery(
  filters: VendorFilters,
): Record<string, string> {
  const query: Record<string, string> = {}
  if (filters.q.trim()) query.q = filters.q.trim()
  if (filters.sort.trim()) query.sort = filters.sort.trim()
  return query
}

function parseOptionalNumber(raw: string | number): number | null | 'invalid' {
  const trimmed = String(raw ?? '')
    .trim()
    .replace(',', '.')
  if (!trimmed) return null
  const num = Number(trimmed)
  return Number.isFinite(num) ? num : 'invalid'
}

export interface VendorFormState {
  name: string
  emptySpoolWeight: string
  externalId: string
  comment: string
}

export function validateVendorForm(
  state: VendorFormState,
):
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; errors: Partial<Record<keyof VendorFormState, string>> } {
  const errors: Partial<Record<keyof VendorFormState, string>> = {}
  const name = state.name.trim()
  if (!name) errors.name = 'Informe o nome do fornecedor.'
  else if (name.length > 64)
    errors.name = 'Use no máximo 64 caracteres para o nome.'

  const emptyWeight = parseOptionalNumber(state.emptySpoolWeight)
  if (emptyWeight === 'invalid' || (emptyWeight !== null && emptyWeight < 0))
    errors.emptySpoolWeight = 'Informe um peso válido maior ou igual a zero.'

  const externalId = state.externalId.trim()
  if (externalId.length > 256)
    errors.externalId = 'Use no máximo 256 caracteres.'

  const comment = state.comment.trim()
  if (comment.length > 1024)
    errors.comment = 'Use no máximo 1024 caracteres nas observações.'

  if (Object.keys(errors).length) return { ok: false, errors }
  return {
    ok: true,
    payload: {
      name,
      empty_spool_weight: emptyWeight,
      external_id: externalId || null,
      comment: comment || null,
    },
  }
}

export interface FilamentFormState {
  name: string
  vendorId: string
  material: string
  density: string
  diameter: string
  weight: string
  spoolWeight: string
  price: string
  articleNumber: string
  extruderTemp: string
  bedTemp: string
  colorMode: 'none' | 'single' | 'multi'
  colorHex: string
  multiColorHexes: string
  multiColorDirection: 'coaxial' | 'longitudinal'
  comment: string
}

export function validateFilamentForm(
  state: FilamentFormState,
):
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; errors: Partial<Record<keyof FilamentFormState, string>> } {
  const errors: Partial<Record<keyof FilamentFormState, string>> = {}

  const name = state.name.trim()
  if (name.length > 64) errors.name = 'Use no máximo 64 caracteres para o nome.'

  const material = state.material.trim()
  if (material.length > 64)
    errors.material = 'Use no máximo 64 caracteres para o material.'

  const density = parseOptionalNumber(state.density)
  if (density === null || density === 'invalid' || density <= 0)
    errors.density = 'Informe uma densidade maior que zero (ex.: 1,24).'

  const diameter = parseOptionalNumber(state.diameter)
  if (diameter === null || diameter === 'invalid' || diameter <= 0)
    errors.diameter = 'Informe um diâmetro maior que zero (ex.: 1,75).'

  const weight = parseOptionalNumber(state.weight)
  if (weight === 'invalid' || (weight !== null && weight <= 0))
    errors.weight = 'Informe um peso líquido maior que zero.'

  const spoolWeight = parseOptionalNumber(state.spoolWeight)
  if (spoolWeight === 'invalid' || (spoolWeight !== null && spoolWeight < 0))
    errors.spoolWeight = 'Informe um peso do carretel maior ou igual a zero.'

  const price = parseOptionalNumber(state.price)
  if (price === 'invalid' || (price !== null && price < 0))
    errors.price = 'Informe um preço válido maior ou igual a zero.'

  const extruderTemp = parseOptionalNumber(state.extruderTemp)
  if (
    extruderTemp === 'invalid' ||
    (extruderTemp !== null &&
      (!Number.isInteger(extruderTemp) || extruderTemp < 0))
  )
    errors.extruderTemp = 'Informe uma temperatura inteira válida.'

  const bedTemp = parseOptionalNumber(state.bedTemp)
  if (
    bedTemp === 'invalid' ||
    (bedTemp !== null && (!Number.isInteger(bedTemp) || bedTemp < 0))
  )
    errors.bedTemp = 'Informe uma temperatura inteira válida.'

  const articleNumber = state.articleNumber.trim()
  if (articleNumber.length > 64)
    errors.articleNumber = 'Use no máximo 64 caracteres.'

  const comment = state.comment.trim()
  if (comment.length > 1024)
    errors.comment = 'Use no máximo 1024 caracteres nas observações.'

  let colorHex: string | null = null
  let multiColorHexes: string | null = null
  let multiColorDirection: 'coaxial' | 'longitudinal' | null = null

  if (state.colorMode === 'single') {
    const normalized = normalizeColorHex(state.colorHex)
    if (!normalized)
      errors.colorHex = 'Informe uma cor hexadecimal válida de 6 ou 8 dígitos.'
    else colorHex = normalized
  } else if (state.colorMode === 'multi') {
    const rawParts = state.multiColorHexes
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
    const normalized = rawParts.map((p) => normalizeColorHex(p))
    if (rawParts.length < 2 || normalized.some((v) => v === null)) {
      errors.multiColorHexes =
        'Informe pelo menos duas cores hexadecimais separadas por vírgula (ex.: FF0000, 0000FF).'
    } else {
      multiColorHexes = (normalized as string[]).join(',')
      multiColorDirection = state.multiColorDirection
    }
  }

  let vendorId: number | null = null
  if (state.vendorId.trim()) {
    const parsed = Number(state.vendorId)
    if (!Number.isSafeInteger(parsed) || parsed < 1)
      errors.vendorId = 'Selecione um fornecedor válido.'
    else vendorId = parsed
  }

  if (Object.keys(errors).length) return { ok: false, errors }
  return {
    ok: true,
    payload: {
      name: name || null,
      vendor_id: vendorId,
      material: material || null,
      density,
      diameter,
      weight,
      spool_weight: spoolWeight,
      price,
      article_number: articleNumber || null,
      settings_extruder_temp: extruderTemp,
      settings_bed_temp: bedTemp,
      color_hex: colorHex,
      multi_color_hexes: multiColorHexes,
      multi_color_direction: multiColorDirection,
      comment: comment || null,
    },
  }
}

export interface SpoolFormState {
  filamentId: string
  initialWeight: string
  spoolWeight: string
  weightMode: 'remaining' | 'used'
  remainingWeight: string
  usedWeight: string
  price: string
  location: string
  lotNr: string
  comment: string
  archived: boolean
}

export function validateSpoolForm(
  state: SpoolFormState,
):
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; errors: Partial<Record<keyof SpoolFormState, string>> } {
  const errors: Partial<Record<keyof SpoolFormState, string>> = {}

  const filamentId = Number(state.filamentId)
  if (
    !state.filamentId.trim() ||
    !Number.isSafeInteger(filamentId) ||
    filamentId < 1
  )
    errors.filamentId = 'Selecione um filamento.'

  const initialWeight = parseOptionalNumber(state.initialWeight)
  if (
    initialWeight === 'invalid' ||
    (initialWeight !== null && initialWeight < 0)
  )
    errors.initialWeight = 'Informe um peso inicial válido.'

  const spoolWeight = parseOptionalNumber(state.spoolWeight)
  if (spoolWeight === 'invalid' || (spoolWeight !== null && spoolWeight < 0))
    errors.spoolWeight = 'Informe um peso do carretel válido.'

  const remainingWeight =
    state.weightMode === 'remaining'
      ? parseOptionalNumber(state.remainingWeight)
      : null
  if (
    state.weightMode === 'remaining' &&
    (remainingWeight === 'invalid' ||
      (remainingWeight !== null && remainingWeight < 0))
  )
    errors.remainingWeight = 'Informe um peso restante válido.'

  const usedWeight =
    state.weightMode === 'used' ? parseOptionalNumber(state.usedWeight) : null
  if (
    state.weightMode === 'used' &&
    (usedWeight === 'invalid' || (usedWeight !== null && usedWeight < 0))
  )
    errors.usedWeight = 'Informe um peso usado válido.'

  const price = parseOptionalNumber(state.price)
  if (price === 'invalid' || (price !== null && price < 0))
    errors.price = 'Informe um preço válido.'

  const location = state.location.trim()
  if (location.length > 64)
    errors.location = 'Use no máximo 64 caracteres para a localização.'

  const lotNr = state.lotNr.trim()
  if (lotNr.length > 64)
    errors.lotNr = 'Use no máximo 64 caracteres para o lote.'

  const comment = state.comment.trim()
  if (comment.length > 1024)
    errors.comment = 'Use no máximo 1024 caracteres nas observações.'

  if (Object.keys(errors).length) return { ok: false, errors }

  const payload: Record<string, unknown> = {
    filament_id: filamentId,
    initial_weight: initialWeight,
    spool_weight: spoolWeight,
    price,
    location: location || null,
    lot_nr: lotNr || null,
    comment: comment || null,
    archived: state.archived,
  }
  if (state.weightMode === 'remaining' && remainingWeight !== null) {
    payload.remaining_weight = remainingWeight
  } else if (state.weightMode === 'used' && usedWeight !== null) {
    payload.used_weight = usedWeight
  }
  return { ok: true, payload }
}

export interface ImportFormState {
  format: ImportFormat
  origin: string
  bearerToken: string
  jsonText: string
  csvEntity: ImportCsvEntity
  csvText: string
  source: string
  dryRun: boolean
  onCollision: ImportCollisionPolicy
  onConflict: ImportConflictPolicy
}

export function validateImportForm(
  state: ImportFormState,
):
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; error: string } {
  const source = state.source.trim()
  if (source && !SOURCE_KEY.test(source)) {
    return {
      ok: false,
      error:
        'O identificador da origem deve começar com letra minúscula ou número e usar apenas letras minúsculas, números, ".", "_", ":" ou "-".',
    }
  }
  const common: Record<string, unknown> = {
    dryRun: state.dryRun,
    onCollision: state.onCollision,
    onConflict: state.onConflict,
    ...(source ? { source } : {}),
  }

  if (state.format === 'spoolman-api') {
    const origin = state.origin.trim()
    if (!origin) return { ok: false, error: 'Informe o endereço do Spoolman.' }
    let parsed: URL
    try {
      parsed = new URL(origin)
    } catch {
      return {
        ok: false,
        error: 'Informe um endereço válido com http:// ou https://.',
      }
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return {
        ok: false,
        error: 'Use um endereço com protocolo http:// ou https://.',
      }
    }
    const token = state.bearerToken.trim()
    return {
      ok: true,
      payload: {
        format: 'spoolman-api',
        origin: parsed.origin,
        ...(token ? { bearerToken: token } : {}),
        ...common,
      },
    }
  }

  if (state.format === 'json') {
    const raw = state.jsonText.trim()
    if (!raw)
      return {
        ok: false,
        error: 'Selecione um arquivo JSON ou cole o conteúdo para importar.',
      }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return {
        ok: false,
        error: 'O conteúdo JSON informado não é válido. Verifique a sintaxe.',
      }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        ok: false,
        error:
          'O JSON deve ser um objeto com as listas de fornecedores, filamentos ou bobinas.',
      }
    }
    return {
      ok: true,
      payload: {
        format: 'json',
        data: parsed,
        ...common,
      },
    }
  }

  const csv = state.csvText.trim()
  if (!csv) {
    return {
      ok: false,
      error: 'Selecione um arquivo CSV ou cole o conteúdo para importar.',
    }
  }
  return {
    ok: true,
    payload: {
      format: 'csv',
      entity: state.csvEntity,
      csv: state.csvText,
      ...common,
    },
  }
}

export function extractApiError(
  cause: unknown,
  fallback: string,
): { message: string; problems: BundleProblem[]; status?: number } {
  if (!cause || typeof cause !== 'object')
    return { message: fallback, problems: [] }
  const record = cause as {
    statusCode?: unknown
    status?: unknown
    data?: unknown
    statusMessage?: unknown
  }
  const status =
    typeof record.statusCode === 'number'
      ? record.statusCode
      : typeof record.status === 'number'
        ? record.status
        : undefined
  const data =
    record.data && typeof record.data === 'object'
      ? (record.data as {
          message?: unknown
          data?: unknown
          problems?: unknown
        })
      : undefined
  const nestedData =
    data?.data && typeof data.data === 'object'
      ? (data.data as { problems?: unknown })
      : undefined
  const rawProblems = Array.isArray(data?.problems)
    ? data.problems
    : Array.isArray(nestedData?.problems)
      ? nestedData.problems
      : []
  const problems: BundleProblem[] = rawProblems.filter(
    (item): item is BundleProblem =>
      Boolean(item) &&
      typeof item === 'object' &&
      typeof (item as BundleProblem).path === 'string' &&
      typeof (item as BundleProblem).problem === 'string',
  )
  const serverMessage =
    typeof data?.message === 'string' && data.message.trim()
      ? data.message.trim()
      : undefined

  const withStatus = status !== undefined ? { status } : {}

  if (status === 401)
    return { message: 'Entre novamente para continuar.', problems, status }
  if (serverMessage) return { message: serverMessage, problems, ...withStatus }
  if (status === 403)
    return {
      message: 'Sua conta não tem permissão para realizar esta ação.',
      problems,
      status,
    }
  if (status === 409)
    return {
      message: 'Não foi possível concluir a alteração devido a um conflito.',
      problems,
      status,
    }
  if (status === 422)
    return {
      message: 'Revise os campos informados e tente novamente.',
      problems,
      status,
    }
  return { message: fallback, problems, ...withStatus }
}

export function reportRows(report: ImportReport) {
  return [
    { key: 'vendors', label: 'Fornecedores', counts: report.vendors },
    { key: 'filaments', label: 'Filamentos', counts: report.filaments },
    { key: 'spools', label: 'Bobinas', counts: report.spools },
    { key: 'fields', label: 'Campos extras', counts: report.fields },
    { key: 'settings', label: 'Configurações', counts: report.settings },
  ] as const
}

export function distinctMaterials(
  items: readonly (
    | Pick<FilamentItem, 'material'>
    | { filament: Pick<FilamentItem, 'material'> }
  )[],
): string[] {
  const seen = new Set<string>()
  for (const item of items) {
    const mat = 'filament' in item ? item.filament.material : item.material
    const trimmed = mat?.trim()
    if (trimmed) seen.add(trimmed)
  }
  return [...seen].sort((a, b) => a.localeCompare(b, 'pt-BR'))
}

export function vendorOptionLabel(vendor: VendorItem): string {
  return vendor.name
}
