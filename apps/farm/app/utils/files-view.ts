import {
  MAX_FILE_SIZE,
  parseOffer,
} from '../../../../packages/farm-protocol/src/file-transfer.ts'
import type { PrinterFile } from '../../../../packages/farm-protocol/src/file-list.ts'
import {
  ControlArguments,
  isAnycubicStartFile,
} from '../../../../packages/farm-protocol/src/control-actions.ts'
import { controlActionAvailability, type Clock } from './farm-control.ts'
import type { FarmKeyState, FarmRow } from './farm-view.ts'
import type { PauseCommandOutcome } from '../../../../packages/connector/src/webrtc/pause-control-session.ts'

export const MAX_UPLOAD_BYTES = MAX_FILE_SIZE
export function validateUpload(file: {
  name: string
  size: number
}): string | undefined {
  if (!/\.(gcode|3mf)$/i.test(file.name))
    return 'Selecione um arquivo .gcode ou .3mf.'
  if (
    !Number.isSafeInteger(file.size) ||
    file.size <= 0 ||
    file.size > MAX_UPLOAD_BYTES
  )
    return 'O arquivo deve ter entre 1 byte e 512 MiB.'
  try {
    parseOffer({
      type: 'offer',
      transfer_id: 'validation',
      printer_key: 'validation',
      name: file.name,
      size: file.size,
      sha256: '0'.repeat(64),
    })
  } catch {
    return 'Nome inválido. Use letras sem acentos, números, espaços, ponto, hífen ou sublinhado, sem dois pontos consecutivos.'
  }
  return undefined
}
export function filesAvailability(
  row: FarmRow,
  keys: FarmKeyState,
  enabled: boolean,
  now: Clock,
) {
  if (!row.observation?.state.controls?.includes('start_print'))
    return {
      available: false as const,
      reason: 'A impressora não anuncia suporte para iniciar impressão.',
    }
  return controlActionAvailability('start_print', row, keys, enabled, now)
}
export function printableFile(name: string, vendor?: string): boolean {
  if (vendor?.toLowerCase() === 'anycubic' && !isAnycubicStartFile(name))
    return false
  return ControlArguments.safeParse({
    action: 'start_print',
    args: { file: name },
  }).success
}
export function printableEntry(
  file: Pick<PrinterFile, 'name' | 'directory' | 'printUnsupported'>,
): boolean {
  return !file.directory && !file.printUnsupported && printableFile(file.name)
}
export function printOutcomeText(
  outcome: PauseCommandOutcome | undefined,
): string {
  switch (outcome) {
    case 'applied':
      return 'Impressão iniciada. O Connector confirmou o comando.'
    case 'rejected':
      return 'O Connector recusou o comando. Nada será repetido automaticamente.'
    case 'not-sent':
      return 'O comando não foi enviado. Nada será repetido automaticamente.'
    default:
      return 'Resultado desconhecido. Verifique a impressora antes de tentar novamente.'
  }
}
