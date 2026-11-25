/** One exact model and firmware pair. */
export type PhrozenQualification = Readonly<{
  model: string
  firmwareVersion: string
}>

/**
 * Pairs whose printer writes (pause, resume, stop, upload) passed a supervised
 * run on hardware. No source below this list is a Phrozen protocol document,
 * so every pair is read-only until then: nothing is offered and nothing is
 * sent. Add a pair only with that run recorded in
 * docs/fullfarmmanager/evidence/phrozen.md.
 */
export const PHROZEN_QUALIFIED_WRITES: readonly PhrozenQualification[] =
  Object.freeze([])

export function phrozenWriteQualified(
  model: string,
  firmwareVersion: string,
  qualified: readonly PhrozenQualification[] = PHROZEN_QUALIFIED_WRITES,
): boolean {
  return qualified.some(
    (pair) => pair.model === model && pair.firmwareVersion === firmwareVersion,
  )
}

/**
 * Advertised only for a qualified pair. `start_print` is listed because the
 * file transfer authority rides on it; every start is still refused (below).
 */
export const PHROZEN_CONTROL_ACTIONS = Object.freeze([
  'pause',
  'resume',
  'cancel',
  'start_print',
] as const)

/**
 * A resin file starts only as a validated library version, and the resin
 * artifact contract (packages/shared/src/print-file/resin-artifacts.ts) has no
 * Phrozen format or profile.
 */
export const PHROZEN_START_MESSAGE =
  'O início de impressão pela Phrozen ainda não é suportado: não há versão validada de arquivo de resina para este modelo. Inicie pela impressora.'

export function phrozenUnqualifiedMessage(model: string, firmware: string) {
  return `Comandos e envio de arquivos na impressora ${model} com firmware ${firmware} ainda não foram qualificados.`
}
