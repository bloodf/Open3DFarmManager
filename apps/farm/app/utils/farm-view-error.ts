import type { FarmViewState } from './farm-view.ts'

type ErrorReason = Extract<FarmViewState, { kind: 'error' }>['reason']

/** Fixed pt-BR text per failure reason; never the server message. */
export function farmViewErrorText(reason: ErrorReason) {
  switch (reason) {
    case 'forbidden':
      return 'Esta farm não está disponível para sua conta.'
    case 'rate-limit':
      return 'Aguarde antes de tentar novamente.'
    case 'account-changed':
      return 'A conta mudou. Entre novamente para confirmar seus dados.'
    case 'invalid-response':
      return 'Não foi possível confirmar os dados recebidos. Tente novamente.'
    case 'unavailable':
      return 'Não foi possível confirmar seus dados. Tente novamente.'
  }
}
