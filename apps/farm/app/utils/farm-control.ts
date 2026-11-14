import type { ControlAction } from '../../../../packages/farm-protocol/src/control-actions.ts'
import {
  controlSourceState,
  controlTargetState,
} from '../../../../packages/farm-protocol/src/control-actions.ts'
import type { PauseCommandOutcome } from '../../../../packages/connector/src/webrtc/pause-control-session.ts'
import { observationAge, type FarmKeyState, type FarmRow } from './farm-view.ts'
import type { FarmPauseControlState } from './webrtc/farm-pause-control.ts'
import { isKobraXPrinterKey } from './kobralink-onboarding.ts'

export type Clock = { wall: number; mono: number }

export type ActionAvailability =
  { available: true } | { available: false; reason: string }

export type ActionButtonState = {
  action: ControlAction
  label: string
  available: boolean
  disabled: boolean
  reason: string
}

export const ACTION_LABELS: Record<ControlAction, string> = {
  pause: 'Pausar',
  resume: 'Retomar',
  cancel: 'Cancelar',
}

export const ACTION_VERBS: Record<ControlAction, string> = {
  pause: 'pausar',
  resume: 'retomar',
  cancel: 'cancelar',
}

export const ACTION_NOUNS: Record<ControlAction, string> = {
  pause: 'Pausa',
  resume: 'Retomada',
  cancel: 'Cancelamento',
}

/**
 * Checks whether an action can be executed on a given printer row.
 * Degraded sessions (connection not 'authenticated' or historical observation)
 * are read-only and disable commands.
 */
export function controlActionAvailability(
  action: ControlAction,
  row: FarmRow,
  keys: FarmKeyState,
  controlEnabled: boolean,
  now: Clock,
): ActionAvailability {
  const noun = ACTION_NOUNS[action]
  if (isKobraXPrinterKey(row.assignment.printerKey)) {
    return {
      available: false,
      reason: `${noun} indisponível. Impressoras Anycubic Kobra X operam somente em leitura; comandos não são qualificados para este dispositivo.`,
    }
  }
  if (!controlEnabled) {
    return {
      available: false,
      reason: `${noun} indisponível. O controle seguro não está habilitado.`,
    }
  }
  if (
    row.assignment.status !== 'active' ||
    row.assignment.connectorStatus !== 'approved'
  ) {
    return {
      available: false,
      reason: `${noun} indisponível. A atribuição ou o Connector não está ativo.`,
    }
  }
  if (keys.kind !== 'available' || !keys.selected) {
    return {
      available: false,
      reason: `${noun} indisponível. Selecione um dispositivo aprovado deste navegador.`,
    }
  }
  const observation = row.observation
  if (
    row.connection !== 'authenticated' ||
    !observation ||
    observation.historical
  ) {
    return {
      available: false,
      reason: `${noun} indisponível. Não há conexão direta ao vivo.`,
    }
  }
  if (observationAge(observation, now).stale) {
    return {
      available: false,
      reason: `${noun} indisponível. O estado da impressora está desatualizado.`,
    }
  }

  // Check if the advertised controls on the snapshot include this action.
  const advertisedControls = observation.state.controls
  if (
    advertisedControls !== undefined &&
    !advertisedControls.includes(action)
  ) {
    return {
      available: false,
      reason: `${noun} indisponível. A ação não é suportada por esta impressora.`,
    }
  }

  // Check state compatibility via controlSourceState
  const currentState = observation.state.state
  if (!controlSourceState(action, currentState)) {
    let stateReason = ''
    switch (action) {
      case 'pause':
        stateReason = 'A impressora não está imprimindo.'
        break
      case 'resume':
        stateReason = 'A impressão não está pausada.'
        break
      case 'cancel':
        stateReason = 'A impressora não está imprimindo nem pausada.'
        break
    }
    return {
      available: false,
      reason: `${noun} indisponível. ${stateReason}`,
    }
  }

  return { available: true }
}

const sampleClock = (): Clock => ({ wall: Date.now(), mono: performance.now() })

export function liveControlActionAvailability(
  action: ControlAction,
  row: FarmRow,
  keys: FarmKeyState,
  controlEnabled: boolean,
  sample: () => Clock = sampleClock,
): ActionAvailability {
  return controlActionAvailability(action, row, keys, controlEnabled, sample())
}

/**
 * Returns the list of buttons for the advertised actions on this printer row.
 * Only advertised actions in row.observation.state.controls are returned!
 * If controls is undefined, falls back to ['pause'] for backwards compatibility.
 * If commandInFlight is true, buttons are disabled.
 * If connection is degraded or action unavailable, buttons are disabled.
 */
export function getPrinterActionButtons(
  row: FarmRow,
  keys: FarmKeyState,
  controlEnabled: boolean,
  commandInFlight: boolean,
  now: Clock,
): ActionButtonState[] {
  const advertised =
    row.observation?.state.controls !== undefined
      ? row.observation.state.controls
      : ['pause' as const]
  return advertised.map((action) => {
    const avail = controlActionAvailability(
      action,
      row,
      keys,
      controlEnabled,
      now,
    )
    const available = avail.available
    const disabled = commandInFlight || !available
    return {
      action,
      label: ACTION_LABELS[action],
      available,
      disabled,
      reason: avail.available ? '' : avail.reason,
    }
  })
}

/**
 * Outcome text for each control action.
 */
export function actionOutcomeText(
  action: ControlAction,
  outcome: PauseCommandOutcome,
): string {
  if (action === 'pause') {
    switch (outcome) {
      case 'applied':
        return 'Impressão pausada. O Connector confirmou a pausa.'
      case 'rejected':
        return 'Comando recusado. A impressora não foi pausada e nada será repetido automaticamente.'
      case 'not-sent':
        return 'O comando não foi enviado à impressora. A impressora não foi pausada.'
      case 'outcome-unknown':
        return 'Não foi possível confirmar se a impressora pausou. Verifique a impressora antes de tentar novamente.'
    }
  }

  const target = controlTargetState(action)
  const actionPast = target === 'printing' ? 'retomada' : 'cancelada'
  const actionNoun = ACTION_NOUNS[action].toLowerCase()

  switch (outcome) {
    case 'applied':
      return `Impressão ${actionPast}. O Connector confirmou a ${actionNoun}.`
    case 'rejected':
      return `Comando recusado. A impressão não foi ${actionPast} e nada será repetido automaticamente.`
    case 'not-sent':
      return `O comando não foi enviado à impressora. A impressão não foi ${actionPast}.`
    case 'outcome-unknown':
      return `Não foi possível confirmar se a impressão foi ${actionPast}. Verifique a impressora antes de tentar novamente.`
  }
}

/**
 * Dialog status copy for any control action.
 */
export function controlStatusText(
  action: ControlAction,
  state: FarmPauseControlState,
  remainingSeconds: number,
): string {
  const verb = ACTION_VERBS[action]
  switch (state.kind) {
    case 'connecting':
      return 'Preparando conexão e autorização seguras…'
    case 'ready':
      return `Autorização pronta. Confirme em até ${Math.max(0, remainingSeconds)} s.`
    case 'sending':
      return `Enviando o comando de ${verb}…`
    case 'settled':
      return actionOutcomeText(action, state.outcome)
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

/**
 * Text for cancel confirmation dialog title & description naming the printer.
 */
export function cancelConfirmationTitle(printerKey: string): string {
  return `Cancelar impressão de ${printerKey}`
}

export function cancelConfirmationDescription(printerKey: string): string {
  return `A impressora ${printerKey} vai cancelar a impressão atual. Esta ação não pode ser desfeita. O comando é assinado neste navegador, enviado diretamente ao Connector por uma conexão segura e nunca é repetido automaticamente.`
}

export function actionDialogTitle(
  action: ControlAction,
  printerKey: string,
): string {
  switch (action) {
    case 'pause':
      return `Pausar impressão de ${printerKey}`
    case 'resume':
      return `Retomar impressão de ${printerKey}`
    case 'cancel':
      return cancelConfirmationTitle(printerKey)
  }
}

export function actionDialogDescription(
  action: ControlAction,
  printerKey: string,
): string {
  switch (action) {
    case 'pause':
      return 'A impressora vai pausar a impressão atual. O comando é assinado neste navegador, enviado diretamente ao Connector por uma conexão segura e nunca é repetido automaticamente.'
    case 'resume':
      return 'A impressora vai retomar a impressão atual. O comando é assinado neste navegador, enviado diretamente ao Connector por uma conexão segura e nunca é repetido automaticamente.'
    case 'cancel':
      return cancelConfirmationDescription(printerKey)
  }
}

export function actionButtonConfirmationLabel(action: ControlAction): string {
  switch (action) {
    case 'pause':
      return 'Confirmar pausa'
    case 'resume':
      return 'Confirmar retomada'
    case 'cancel':
      return 'Confirmar cancelamento'
  }
}
