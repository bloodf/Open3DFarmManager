// Models whose LAN reports differ from the Kobra 3 (20024) path. Sources per
// fact: docs/fullfarmmanager/evidence/anycubic-fdm-models.md. Nothing here was
// captured by this project. "Kobra 3 Max V2" is absent on purpose: no source
// gives its LAN model id.

export type AnycubicLanModel = Readonly<{
  name: string
  /** Enclosed: reports a chamber temperature. */
  chamber: boolean
  /** Light type 2. Without it, a type 2 entry in a report is not a lamp. */
  chamberLight: boolean
  bedMaxCelsius: number
}>

const MODELS: Readonly<Record<string, AnycubicLanModel>> = Object.freeze({
  '20028': Object.freeze({
    name: 'Anycubic Kobra 4',
    chamber: false,
    chamberLight: false,
    bedMaxCelsius: 100,
  }),
  '20029': Object.freeze({
    name: 'Anycubic Kobra S1 Max',
    chamber: true,
    chamberLight: true,
    bedMaxCelsius: 120,
  }),
})

export function anycubicLanModel(
  modelId: string,
): AnycubicLanModel | undefined {
  return Object.hasOwn(MODELS, modelId) ? MODELS[modelId] : undefined
}

/** One exact model id and firmware pair. */
export type AnycubicQualification = Readonly<{
  modelId: string
  firmwareVersion: string
}>

/**
 * Pairs whose writes passed a supervised run on hardware. It ships empty, so
 * every model above is read-only. Add a pair only with that run recorded in
 * docs/fullfarmmanager/evidence/anycubic-fdm-models.md. The Kobra 3 (20024)
 * path does not read this list.
 */
export const ANYCUBIC_QUALIFIED_WRITES: readonly AnycubicQualification[] =
  Object.freeze([])

export function anycubicWriteQualified(
  modelId: string,
  firmwareVersion: string,
  qualified: readonly AnycubicQualification[] = ANYCUBIC_QUALIFIED_WRITES,
): boolean {
  return (
    anycubicLanModel(modelId) !== undefined &&
    qualified.some(
      (pair) =>
        pair.modelId === modelId && pair.firmwareVersion === firmwareVersion,
    )
  )
}

export function anycubicUnqualifiedMessage(modelId: string) {
  return `Comandos na impressora ${anycubicLanModel(modelId)?.name ?? 'Anycubic'} ainda não foram qualificados.`
}

export const ANYCUBIC_LAN_START_MESSAGE =
  'O início de impressão neste modelo Anycubic ainda não é suportado. Inicie pela impressora.'
