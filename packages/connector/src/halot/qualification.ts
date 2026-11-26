// Every HALOT write stays off until the owner qualifies it on hardware.
// Evidence and gaps: docs/fullfarmmanager/evidence/halot.md

export type HalotWrite = 'pause' | 'resume' | 'cancel'

/**
 * No HALOT reply names the model or the firmware, so an entry qualifies a
 * model the owner declares and the Connector cannot check. Upload and start
 * have no entry kind: they are not implemented.
 */
export type HalotQualification = Readonly<{
  operation: HalotWrite
  model: string
  /** Hardware-qualified additional starting states for resume. */
  resumeFrom?: readonly string[]
  /** Hardware-qualified stop-specific states; natural completion is excluded. */
  cancelReached?: readonly string[]
}>

/** Empty on purpose. Neither the wire nor the runtime file can add an entry. */
export const HALOT_QUALIFIED_WRITES: readonly HalotQualification[] =
  Object.freeze([])

/** The operations qualified for this model; empty with the shipped list. */
export function halotControls(
  model: string,
  qualified: readonly HalotQualification[] = HALOT_QUALIFIED_WRITES,
): readonly HalotWrite[] {
  return (['pause', 'resume', 'cancel'] as const).filter((operation) =>
    qualified.some(
      (entry) => entry.model === model && entry.operation === operation,
    ),
  )
}

export const HALOT_START_MESSAGE =
  'O envio de arquivos e o início de impressão em impressoras HALOT não são suportados. Inicie pela impressora.'

export function halotUnqualifiedMessage(model: string) {
  return `Comandos na impressora ${model} ainda não foram qualificados em hardware.`
}
