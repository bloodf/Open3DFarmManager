import { checkCompatibility } from '../../../../packages/shared/src/print-file/compatibility.ts'
import type { LibraryPrintArgs } from '../../../../packages/farm-protocol/src/control-actions.ts'
import { RESULT_CODE_HINTS } from './farm-control.ts'
import type { LibraryMetadata, StorageMode } from './library-view.ts'

/** One library version as the replay dialog needs it. */
export type ReplaySource = {
  versionId?: string
  sha256: string
  name: string
  kind: 'gcode' | '3mf'
  plateCount: number
  metadata: LibraryMetadata
  /** Where THIS version is stored, whatever the farm mode is today. */
  storageLocation: StorageMode
  agentId: string | null
  /** The stored file was removed (retention or deletion). */
  purged?: boolean
}
export type ReplayMaterial = {
  slot: string
  materialType?: string
  /** `RRGGBBAA`, as the Connector reports it. */
  colorHex?: string
  remainingPercent?: number
  spoolmanRemainingPercent?: number
  spoolmanColorHex?: string
}
export type ReplayPrinter = {
  key: string
  label: string
  agentId: string
  model: string
  compatibleModels?: readonly string[]
  nozzleDiameters: readonly number[]
  backend?: string
  connectorOnline: boolean
  /** A live, authenticated session to the Connector exists. */
  live: boolean
  state?: string
  materials: readonly ReplayMaterial[]
}
export type ReplayLevel = 'ok' | 'warn' | 'blocked'
export type ReplayEntry = {
  printer: ReplayPrinter
  level: ReplayLevel
  reasons: string[]
  /** Set when the printer cannot be picked, even if it is compatible. */
  disabledReason?: string
}
export type ReplayGroups = Record<ReplayLevel, ReplayEntry[]>
export type ReplayResult = {
  outcome: 'applied' | 'rejected' | 'not-sent' | 'outcome-unknown'
  code?: string
  reasons?: readonly string[]
  source?: 'cache' | 'download' | 'local'
}

export const GROUP_LABELS: Record<ReplayLevel, string> = {
  ok: 'Compatíveis',
  warn: 'Compatíveis com ressalvas',
  blocked: 'Bloqueadas ou indisponíveis',
}

const colour = (hex: string | undefined) =>
  hex && /^[0-9A-F]{8}$/i.test(hex) ? `#${hex.slice(0, 6)}` : undefined

/** Why a printer cannot be picked right now; undefined when it can. */
export function disabledReason(
  source: ReplaySource,
  printer: ReplayPrinter,
): string | undefined {
  if (source.purged)
    return 'O arquivo desta versão foi removido da biblioteca. Envie o arquivo novamente.'
  const connectorMode = source.storageLocation === 'connector'
  if (connectorMode && source.agentId !== printer.agentId)
    return 'O arquivo está guardado em outro Connector, que não é o desta impressora.'
  if (!printer.connectorOnline)
    return connectorMode
      ? 'O Connector que guarda o arquivo está offline. Ligue-o para imprimir de novo.'
      : 'O Connector desta impressora está offline.'
  if (!printer.live)
    return 'Não há conexão direta segura com o Connector. Nenhum comando pode ser enviado.'
  if (printer.state && !['idle', 'cancelled'].includes(printer.state))
    return 'A impressora não está ociosa.'
  return undefined
}

/** Groups printers by compatibility; unavailable ones fall in the blocked group. */
export function groupPrinters(
  source: ReplaySource,
  printers: readonly ReplayPrinter[],
): ReplayGroups {
  const groups: ReplayGroups = { ok: [], warn: [], blocked: [] }
  for (const printer of printers) {
    const verdict = checkCompatibility(
      { ...source.metadata, format: source.kind },
      {
        model: printer.model,
        compatibleModels: printer.compatibleModels ?? [],
        nozzleDiameters: printer.nozzleDiameters,
      },
      printer.materials.map((m) => ({
        ...(m.materialType ? { type: m.materialType } : {}),
        ...(colour(m.colorHex) ? { colour: colour(m.colorHex)! } : {}),
      })),
    )
    const reasons = verdict.reasons
      .filter((r) => r.level !== 'info')
      .map((r) => r.message)
    const unavailable = disabledReason(source, printer)
    const level: ReplayLevel =
      verdict.level === 'block' || unavailable ? 'blocked' : verdict.level
    groups[level].push({
      printer,
      level,
      reasons,
      ...(unavailable ? { disabledReason: unavailable } : {}),
    })
  }
  return groups
}

/** Same printer when it can be picked, else the first ok, then warn, entry. */
export function defaultPrinter(
  groups: ReplayGroups,
  preferred: string | undefined,
): string {
  const pickable = [...groups.ok, ...groups.warn]
  return (
    pickable.find((e) => e.printer.key === preferred && !e.disabledReason)
      ?.printer.key ??
    pickable.find((e) => !e.disabledReason)?.printer.key ??
    ''
  )
}

export const usesAms = (source: ReplaySource, printer: ReplayPrinter) =>
  printer.backend === 'bambu' && source.kind === '3mf'

/** AMS value for a loaded slot: its own number when numeric, else its position. */
const slotValue = (m: ReplayMaterial, index: number) =>
  /^\d{1,3}$/.test(m.slot) ? Number(m.slot) : index

/** Suggests one slot per filament: colour and type, then type; -1 when none fits. */
export function suggestMapping(
  source: ReplaySource,
  printer: ReplayPrinter,
): number[] {
  const taken = new Set<number>()
  return (source.metadata.tools ?? []).map((tool) => {
    const type = tool.filamentType?.toLowerCase()
    const want = tool.filamentColour?.toLowerCase()
    const fits = (match: (m: ReplayMaterial) => boolean) =>
      printer.materials.findIndex((m, i) => !taken.has(i) && !!type && match(m))
    const sameType = (m: ReplayMaterial) =>
      m.materialType?.toLowerCase() === type
    let index = fits(
      (m) => sameType(m) && colour(m.colorHex)?.toLowerCase() === want,
    )
    if (index < 0) index = fits(sameType)
    if (index < 0) return -1
    taken.add(index)
    return slotValue(printer.materials[index]!, index)
  })
}

export type ReplayChoice = {
  printer: ReplayPrinter
  source: ReplaySource
  plate: number
  mapping: readonly number[]
  bedClear: boolean
}

/** Why the print cannot be confirmed yet; undefined when it can. */
export function confirmationError(choice: ReplayChoice): string | undefined {
  const { printer, source } = choice
  if (usesAms(source, printer) && choice.mapping.some((slot) => slot < 0))
    return 'Associe cada filamento do arquivo a um slot carregado.'
  if (!choice.bedClear) return 'Confirme que a mesa está limpa.'
  return undefined
}

/** The `start_library_print` arguments; plate and AMS apply only to Bambu. */
export function buildArgs(choice: ReplayChoice): LibraryPrintArgs {
  const { printer, source } = choice
  const bambu = printer.backend === 'bambu'
  return {
    sha256: source.sha256,
    ...(bambu ? { plate: choice.plate } : {}),
    ...(usesAms(source, printer) && choice.mapping.length
      ? { ams_mapping: [...choice.mapping] }
      : {}),
  }
}

/** Plain pt-BR text for each refusal code the Connector may return. */
export const REFUSAL_TEXT: Record<string, string> = {
  ...RESULT_CODE_HINTS,
  'stale-selection': 'A seleção mudou. Confira o arquivo e a impressora.',
  'library-unavailable': 'Não foi possível verificar a versão na biblioteca.',
  'webrtc-unavailable': 'A conexão ao vivo com o Connector está indisponível.',
  incompatible: 'O arquivo é incompatível com esta impressora.',
  'download-failed':
    'O Connector não conseguiu baixar o arquivo da biblioteca do servidor.',
  'checksum-mismatch':
    'O arquivo não confere com o SHA-256 registrado e não será impresso.',
  'cache-full':
    'O cache do Connector está cheio e não há espaço para este arquivo.',
  'local-file-missing':
    'O arquivo não está na biblioteca do Connector. Envie o arquivo novamente.',
  'bambu-authorization-required':
    'A impressora Bambu recusou o comando. Ative o modo Somente LAN e o Modo Desenvolvedor no painel dela.',
}

const SOURCE_TEXT = {
  cache: 'copiado do cache do Connector',
  download: 'baixado do servidor pelo Connector',
  local: 'lido da biblioteca do Connector',
} as const

/** Outcome text; `retry` is never offered, an uncertain command stays uncertain. */
export function replayOutcomeText(result: ReplayResult): string {
  switch (result.outcome) {
    case 'applied':
      return `Impressão iniciada. O Connector confirmou o comando${
        result.source ? ` (arquivo ${SOURCE_TEXT[result.source]})` : ''
      }.`
    case 'rejected': {
      const why =
        (result.code && REFUSAL_TEXT[result.code]) ??
        'O Connector recusou o comando.'
      return `${why} A impressão não foi iniciada e nada será repetido automaticamente.`
    }
    case 'not-sent':
      // The Connector refuses a library start before anything reaches the
      // printer and says why; the dialog repeats that reason.
      return result.code && REFUSAL_TEXT[result.code]
        ? `${REFUSAL_TEXT[result.code]} A impressão não foi iniciada e nada será repetido automaticamente.`
        : 'O comando não foi enviado ao Connector. A impressão não foi iniciada.'
    case 'outcome-unknown':
      return 'Não foi possível confirmar se a impressão começou. Verifique a impressora antes de tentar novamente; nada será repetido automaticamente.'
  }
}
