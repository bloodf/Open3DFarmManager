import type { ExtendedControlAction } from '../../../farm-protocol/src/control-actions.ts'
import type { KobraXFacts } from './facts.ts'

/**
 * What the printer has itself reported. Nothing here comes from configuration
 * or from the wire's own claims about support: only from reports.
 */
export interface KobraXControlEvidence {
  /** At least one ACE unit (box id 0 to 3) appeared in a report. */
  readonly ace: boolean
  /** The chamber light (type 3) appeared in a report. */
  readonly light: boolean
  /** The part fan speed appeared in a report. */
  readonly fan: boolean
}

/** Every signed action the native driver can carry out, in advertised order. */
export const KOBRA_X_SIGNED_ACTIONS: readonly ExtendedControlAction[] =
  Object.freeze([
    'pause',
    'resume',
    'cancel',
    'set_temperature',
    'set_fan',
    'set_light',
    'start_print',
    'load_filament',
    'unload_filament',
  ])

/**
 * Actions that need a reported accessory. Every Kobra X has a nozzle, a bed
 * and file printing, so those never wait for evidence.
 */
const ACCESSORY_ACTIONS: Readonly<
  Partial<Record<ExtendedControlAction, keyof KobraXControlEvidence>>
> = {
  set_fan: 'fan',
  set_light: 'light',
  load_filament: 'ace',
  unload_filament: 'ace',
}

/**
 * The controls to offer for one printer. Without evidence (nothing reported
 * yet, or the printer is unreachable) only the accessory-free actions remain.
 */
export function kobraXControls(
  evidence: KobraXControlEvidence | undefined,
): readonly ExtendedControlAction[] {
  return Object.freeze(
    KOBRA_X_SIGNED_ACTIONS.filter((action) => {
      const needs = ACCESSORY_ACTIONS[action]
      return needs === undefined || evidence?.[needs] === true
    }),
  )
}

export function sameKobraXEvidence(
  a: KobraXControlEvidence | undefined,
  b: KobraXControlEvidence | undefined,
): boolean {
  return (
    a === b ||
    (a !== undefined &&
      b !== undefined &&
      a.ace === b.ace &&
      a.light === b.light &&
      a.fan === b.fan)
  )
}

/**
 * Evidence from one live connection. `light` and `fan` are what the status
 * snapshot has read from reports; `ace` is what the report facts list.
 */
export function readKobraXControlEvidence(
  facts: Pick<KobraXFacts, 'boxes'>,
  snapshot: {
    light?: unknown
    fans?: { part?: unknown } | undefined
  },
): KobraXControlEvidence {
  return Object.freeze({
    ace: facts.boxes.some((box) => box.id >= 0 && box.id <= 3),
    light: snapshot.light !== undefined,
    fan: typeof snapshot.fans?.part === 'number',
  })
}

/** One request waits for its result at most this long (`requests.ts`). */
export const KOBRA_X_REQUEST_RESULT_MS = 5000
/** Each wait for a current-state or box report after a result. */
export const KOBRA_X_REPORT_WAIT_MS = 3000
/** `start_print` watches for the printer ending the task itself. */
export const KOBRA_X_START_WATCH_MS = 1500
/** Scheduling slack on top of the summed waits. */
const RESULT_MARGIN_MS = 500

/**
 * Longest the steps after the write can take: the request's own result wait,
 * then, for `start_print`, the invalid-start watch, then one current-state
 * wait. Waits before the write are not counted: a command that has not been
 * written is never uncertain.
 */
export function kobraXResultWindowMs(
  action: ExtendedControlAction,
): number | undefined {
  if (!KOBRA_X_SIGNED_ACTIONS.includes(action)) return undefined
  return (
    KOBRA_X_REQUEST_RESULT_MS +
    (action === 'start_print' ? KOBRA_X_START_WATCH_MS : 0) +
    KOBRA_X_REPORT_WAIT_MS +
    RESULT_MARGIN_MS
  )
}
