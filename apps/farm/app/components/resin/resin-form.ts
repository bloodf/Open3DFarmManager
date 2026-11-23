import { resinLedgerEntry } from '../../../server/utils/resin-ledger/entry.ts'

export type ResinKind = 'vat' | 'bottle' | 'volume' | 'film' | 'lcd'
export interface ResinFormState {
  kind: ResinKind
  target: 'vat' | 'bottle'
  name: string
  /** Text as typed; an empty bottle volume means "Não informado". */
  volume: string
  layers: string
  hours: string
}
export const emptyResinForm = (): ResinFormState => ({
  kind: 'vat',
  target: 'vat',
  name: '',
  volume: '',
  layers: '',
  hours: '',
})

export const resinKindLabels: Record<ResinKind, string> = {
  vat: 'Troca de cuba',
  bottle: 'Garrafa de resina',
  volume: 'Ajuste de volume',
  film: 'Contador do filme (camadas)',
  lcd: 'Contador do LCD (horas)',
}

const number = (text: string): number | undefined => {
  const value = text.trim().replace(',', '.')
  return value === '' ? undefined : Number(value)
}

/** Browser entries are always manual. Empty bottle volume stays unknown (null). */
export function resinEntryFromForm(
  form: ResinFormState,
): { ok: true; entry: unknown } | { ok: false; message: string } {
  const volume = number(form.volume)
  const draft =
    form.kind === 'vat'
      ? { kind: 'vat', name: form.name, source: 'manual' }
      : form.kind === 'bottle'
        ? {
            kind: 'bottle',
            name: form.name,
            volumeMl: volume === undefined ? null : volume,
            source: 'manual',
          }
        : form.kind === 'volume'
          ? {
              kind: 'volume',
              target: form.target,
              name: form.name,
              volumeMl: volume,
              source: 'manual',
            }
          : form.kind === 'film'
            ? { kind: 'film', layers: number(form.layers), source: 'manual' }
            : { kind: 'lcd', hours: number(form.hours), source: 'manual' }
  const parsed = resinLedgerEntry.safeParse(draft)
  return parsed.success
    ? { ok: true, entry: parsed.data }
    : {
        ok: false,
        message:
          'Revise os campos: informe nomes preenchidos e valores numéricos não negativos.',
      }
}

export const unknownText = 'Não informado'
export const sourceLabel = (source: 'manual' | 'reported') =>
  source === 'manual' ? 'Manual' : 'Informado pela impressora'
