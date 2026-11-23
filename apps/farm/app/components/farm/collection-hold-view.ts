import type { FarmRow } from '../../utils/farm-view.ts'

export const COLLECTION_ACTION_LABEL = 'Confirmar placa livre'
export const COLLECTION_DIALOG_DESCRIPTION =
  'Confirme que as peças do trabalho anterior foram retiradas e que a placa está livre. O Connector libera o próximo trabalho do OpenFarm para esta impressora; nenhum comando é enviado à impressora e nada será repetido automaticamente.'
export const NATIVE_QUEUE_WARNING =
  'Esta impressora tem a fila nativa do Moonraker. Se a transição automática dessa fila estiver ativada, o OpenFarm não consegue retê-la: a impressora pode iniciar o próximo trabalho sozinha, com peças ainda na placa. Desative a transição automática ou confira a placa antes de cada trabalho.'

export type CollectionHoldView = Readonly<{
  /** The Connector holds this printer's next OpenFarm copy. */
  awaiting: boolean
  /** End time (ms) of the run the operator sees; sent with the confirmation. */
  attempt: string | undefined
  status: string
  nativeQueueWarning: boolean
}>

/**
 * Display only: the Connector decides. It advertises `confirm_collection`
 * while a finished OpenFarm run awaits collection, and refuses starts until
 * the confirmation arrives over the signed WebRTC path.
 */
export function collectionHoldView(row: FarmRow): CollectionHoldView {
  const state = row.observation?.state
  const controls = state?.controls
  const awaiting = controls?.includes('confirm_collection') === true
  const endedAt = state?.lastJob?.endedAt
  const attempt =
    awaiting && endedAt !== undefined && Number.isSafeInteger(endedAt)
      ? String(endedAt)
      : undefined
  return {
    awaiting,
    attempt,
    status: !awaiting
      ? ''
      : attempt
        ? 'Aguardando retirada. O próximo trabalho do OpenFarm para esta impressora fica retido até alguém confirmar que a placa está livre.'
        : 'Aguardando retirada. Aguarde a observação do último trabalho para confirmar que a placa está livre.',
    nativeQueueWarning: controls?.includes('queue_op') === true,
  }
}
