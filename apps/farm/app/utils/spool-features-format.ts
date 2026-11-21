import type {
  SlotAssignment,
  SlotKind,
  UsageGroupBy,
} from './spool-features-types.ts'

const TIME_ZONE = 'America/Sao_Paulo'
const dateTime = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: TIME_ZONE,
})

export const SLOT_KIND_LABELS: Record<SlotKind, string> = {
  printer: 'Impressora (carretel externo)',
  ams: 'AMS',
  toolhead: 'Cabeçote',
}

export const GROUP_BY_OPTIONS: readonly {
  value: UsageGroupBy
  label: string
}[] = [
  { value: 'job', label: 'Por trabalho' },
  { value: 'printer', label: 'Por impressora' },
  { value: 'filament', label: 'Por filamento' },
  { value: 'period', label: 'Por dia' },
]

export function slotLabel(kind: SlotKind, index: number): string {
  return `${SLOT_KIND_LABELS[kind].split(' (')[0]} ${index + 1}`
}

export function formatGrams(grams: number | null | undefined): string {
  if (grams === null || grams === undefined || !Number.isFinite(grams))
    return '—'
  return `${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(grams)} g`
}

export function formatMoney(
  value: number | null | undefined,
  currency: string,
): string {
  if (value === null || value === undefined || !Number.isFinite(value))
    return '—'
  try {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency,
    }).format(value)
  } catch {
    return `${value.toFixed(2)} ${currency}`
  }
}

export function formatStamp(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  return dateTime.format(new Date(ms))
}

export function activeAssignments(
  assignments: readonly SlotAssignment[],
): SlotAssignment[] {
  return assignments
    .filter((item) => item.unassignedAt === null)
    .sort(
      (a, b) =>
        a.slotKind.localeCompare(b.slotKind) || a.slotIndex - b.slotIndex,
    )
}

/** Parses a non-negative number typed by a person; accepts a decimal comma. */
export function parseAmount(
  raw: string,
  options: { min?: number; max: number },
): { ok: true; value: number } | { ok: false; error: string } {
  const text = raw.trim().replace(',', '.')
  if (!text || !/^\d+(\.\d+)?$/.test(text))
    return { ok: false, error: 'Informe um número válido.' }
  const value = Number(text)
  const min = options.min ?? 0
  if (!Number.isFinite(value) || value < min || value > options.max)
    return {
      ok: false,
      error: `Informe um valor entre ${min} e ${options.max}.`,
    }
  return { ok: true, value }
}

/** Threshold input: empty means "use the farm default" (null). */
export function parseThreshold(
  raw: string,
): { ok: true; value: number | null } | { ok: false; error: string } {
  if (!raw.trim()) return { ok: true, value: null }
  const parsed = parseAmount(raw, { max: 1_000_000 })
  return parsed.ok ? parsed : { ok: false, error: parsed.error }
}

/** `datetime-local` value (America/Sao_Paulo wall clock, UTC-3) to epoch ms. */
export function localInputToMs(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!match) return null
  const [, y, mo, d, h, mi] = match.map(Number) as number[]
  const ms = Date.UTC(y!, mo! - 1, d!, h! + 3, mi!)
  return Number.isFinite(ms) ? ms : null
}

export function msToLocalInput(ms: number): string {
  const shifted = new Date(ms - 3 * 3_600_000)
  return shifted.toISOString().slice(0, 16)
}

export function usageReportHref(
  farmId: string,
  groupBy: UsageGroupBy,
  format: 'csv' | 'json' = 'csv',
): string {
  return `/api/farms/${farmId}/spool-library/reports/usage?groupBy=${groupBy}&format=${format}`
}

export function inventoryReportHref(
  farmId: string,
  view: 'groups' | 'low-stock',
): string {
  return `/api/farms/${farmId}/spool-library/reports/inventory?format=csv&view=${view}`
}

export function labelsHref(
  farmId: string,
  spoolIds: readonly number[],
): string {
  return `/api/farms/${farmId}/spool-library/labels?spoolIds=${spoolIds.join(',')}`
}

export interface DryingFormInput {
  spoolId: string
  startedAt: string
  endedAt: string
  temperature: string
  notes: string
}

export function validateDrying(form: DryingFormInput):
  | {
      ok: true
      body: {
        spoolId: number
        startedAt: number
        endedAt: number | null
        temperatureCelsius: number
        notes: string | null
      }
    }
  | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {}
  const spoolId = Number(form.spoolId)
  if (!Number.isSafeInteger(spoolId) || spoolId < 1)
    errors.spoolId = 'Escolha uma bobina.'
  const startedAt = localInputToMs(form.startedAt)
  if (startedAt === null) errors.startedAt = 'Informe o início da secagem.'
  const endedAt = form.endedAt ? localInputToMs(form.endedAt) : null
  if (form.endedAt && endedAt === null) errors.endedAt = 'Data de fim inválida.'
  else if (startedAt !== null && endedAt !== null && endedAt < startedAt)
    errors.endedAt = 'O fim deve ser depois do início.'
  const temperature = parseAmount(form.temperature, { max: 300 })
  if (!temperature.ok) errors.temperature = temperature.error
  if (form.notes.length > 1024) errors.notes = 'Use até 1024 caracteres.'
  if (Object.keys(errors).length > 0) return { ok: false, errors }
  return {
    ok: true,
    body: {
      spoolId,
      startedAt: startedAt as number,
      endedAt,
      temperatureCelsius: (temperature as { value: number }).value,
      notes: form.notes.trim() ? form.notes.trim() : null,
    },
  }
}
