import type { PauseCommandOutcome } from '../../../../packages/connector/src/webrtc/pause-control-session.ts'
import { observationAge, type FarmKeyState, type FarmRow } from './farm-view.ts'
import type { FarmPauseControlState } from './webrtc/farm-pause-control.ts'
import { isKobraXPrinterKey } from './kobralink-onboarding.ts'

type Clock = { wall: number; mono: number }

export type PauseAvailability =
  { available: true } | { available: false; reason: string }

/**
 * Pause is offered only for a live, current observation of a printing printer
 * on an active assignment, with an approved local device key selected and the
 * pause control path enabled on this server. Everything else explains why.
 */
export function pauseAvailability(
  row: FarmRow,
  keys: FarmKeyState,
  pauseEnabled: boolean,
  now: Clock,
): PauseAvailability {
  if (isKobraXPrinterKey(row.assignment.printerKey))
    return {
      available: false,
      reason:
        'Pausa indisponível. Impressoras Anycubic Kobra X operam somente em leitura; comandos não são qualificados para este dispositivo.',
    }
  if (!pauseEnabled)
    return {
      available: false,
      reason: 'Pausa indisponível. O controle seguro não está habilitado.',
    }
  if (
    row.assignment.status !== 'active' ||
    row.assignment.connectorStatus !== 'approved'
  )
    return {
      available: false,
      reason: 'Pausa indisponível. A atribuição ou o Connector não está ativo.',
    }
  if (keys.kind !== 'available' || !keys.selected)
    return {
      available: false,
      reason:
        'Pausa indisponível. Selecione um dispositivo aprovado deste navegador.',
    }
  const observation = row.observation
  if (
    row.connection !== 'authenticated' ||
    !observation ||
    observation.historical
  )
    return {
      available: false,
      reason: 'Pausa indisponível. Não há conexão direta ao vivo.',
    }
  if (observationAge(observation, now).stale)
    return {
      available: false,
      reason: 'Pausa indisponível. O estado da impressora está desatualizado.',
    }
  if (observation.state.state !== 'printing')
    return {
      available: false,
      reason: 'Pausa indisponível. A impressora não está imprimindo.',
    }
  return { available: true }
}

const sampleClock = (): Clock => ({ wall: Date.now(), mono: performance.now() })

/**
 * `pauseAvailability` against a clock sampled at the moment of the check. The
 * page clock only ticks once a second, so a frame received after the last tick
 * would otherwise look like a negative, stale age. A sample older than the
 * frame, or a non-finite one, still counts as stale.
 */
export function livePauseAvailability(
  row: FarmRow,
  keys: FarmKeyState,
  pauseEnabled: boolean,
  sample: () => Clock = sampleClock,
): PauseAvailability {
  return pauseAvailability(row, keys, pauseEnabled, sample())
}

const outcomeText: Record<PauseCommandOutcome, string> = {
  applied: 'Impressão pausada. O Connector confirmou a pausa.',
  rejected:
    'Comando recusado. A impressora não foi pausada e nada será repetido automaticamente.',
  'not-sent':
    'O comando não foi enviado à impressora. A impressora não foi pausada.',
  'outcome-unknown':
    'Não foi possível confirmar se a impressora pausou. Verifique a impressora antes de tentar novamente.',
}

/** Dialog status copy. `remainingSeconds` applies to the ready state only. */
export function pauseStatusText(
  state: FarmPauseControlState,
  remainingSeconds: number,
): string {
  switch (state.kind) {
    case 'connecting':
      return 'Preparando conexão e autorização seguras…'
    case 'ready':
      return `Autorização pronta. Confirme em até ${Math.max(0, remainingSeconds)} s.`
    case 'sending':
      return 'Enviando o comando de pausa…'
    case 'settled':
      return outcomeText[state.outcome]
    case 'failed':
      switch (state.reason) {
        case 'unavailable':
          return 'Não foi possível obter uma autorização segura. Nenhum comando foi enviado.'
        case 'not-ready':
          return 'A autorização não ficou pronta. Nenhum comando foi enviado. Confira se a data e a hora deste dispositivo estão corretas e tente novamente.'
        case 'expired':
          return 'A autorização expirou antes da confirmação. Nenhum comando foi enviado.'
        case 'closed':
          return 'A conexão segura foi encerrada. Nenhum comando foi enviado.'
      }
  }
}
