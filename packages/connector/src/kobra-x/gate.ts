import type { KobraXFacts } from './facts.ts'

export type KobraXPrinterState =
  'idle' | 'printing' | 'paused' | 'error' | 'offline'

export type KobraXGateAction =
  | 'pause'
  | 'resume'
  | 'stop'
  | 'light'
  | 'fan'
  | 'speed'
  | 'home'
  | 'jog'
  | 'heat'
  | 'skip'
  | 'ace-feed'
  | 'ace-retract'
  | 'ace-dry-start'
  | 'ace-dry-stop'
  | 'ace-slot-edit'
  | 'ace-auto-feed'
  | 'file-list'
  | 'file-details'
  | 'file-delete'
  | 'upload'
  | 'print-start'

const READ_ONLY = new Set<KobraXGateAction>(['file-list', 'file-details'])
const PREPARING_ONLY = new Set([
  'checking',
  'hotbed_heating',
  'nozzle_heating',
  'ace_filament_unfeeding',
  'ace_filament_feeding',
  'nozzle_purging',
  'nozzle_wiping',
  'nozzle_cooling',
  'auto_leveling',
  'z_offset_calibrating',
  'frequency_sweeping',
  'hotbed_cooling_off',
  'nozzle_cooling_off',
])

export interface KobraXGateInput {
  action: KobraXGateAction
  state: KobraXPrinterState
  facts: KobraXFacts
  /** The ACE slot the action targets, when it has one. */
  slot?: number | undefined
  /** The file the action targets, when it has one. */
  filename?: string | undefined
}

/**
 * Refusals decided before anything is published, from the last reported
 * state. Returns a reason, or null when the action may be sent. A stale or
 * missing report refuses; it never allows.
 */
export function kobraXGate(input: KobraXGateInput): string | null {
  const { action, state, facts } = input
  if (state === 'offline') return 'printer-offline'
  if (state === 'error') return READ_ONLY.has(action) ? null : 'printer-error'
  if (READ_ONLY.has(action)) return null
  const job = state === 'printing' || state === 'paused'
  const quiet =
    state === 'idle' && !facts.jobActive && facts.infoState === 'free'
  const box = facts.boxes[0]
  switch (action) {
    case 'pause':
      if (state !== 'printing') return 'not-printing'
      return facts.jobPhase && PREPARING_ONLY.has(facts.jobPhase)
        ? 'job-preparing'
        : null
    case 'resume':
      return state === 'paused' ? null : 'not-paused'
    case 'stop':
      return job ? null : 'no-job'
    case 'light':
    case 'fan':
      return null
    case 'speed':
      return state === 'printing' ? null : 'not-printing'
    case 'skip':
      return job ? null : 'no-job'
    case 'home':
    case 'jog':
      // No motion while a job runs, is paused, or the printer is busy.
      return quiet ? null : job || facts.jobActive ? 'job-active' : 'busy'
    case 'heat':
    case 'ace-slot-edit':
    case 'ace-auto-feed':
    case 'ace-dry-start':
      if (!quiet) return job || facts.jobActive ? 'job-active' : 'busy'
      if (action === 'ace-dry-start' && box?.dryingActive)
        return 'already-drying'
      return null
    case 'ace-dry-stop':
      return box?.dryingActive ? null : 'not-drying'
    case 'ace-feed':
    case 'ace-retract': {
      if (!quiet) return job || facts.jobActive ? 'job-active' : 'busy'
      if (box?.dryingActive) return 'drying'
      const slot = input.slot
      if (action === 'ace-feed')
        return box?.slots.some((s) => s.index === slot) ? null : 'unknown-slot'
      return box &&
        box.loadedSlot >= 0 &&
        (slot === undefined || slot === box.loadedSlot)
        ? null
        : 'nothing-loaded'
    }
    case 'file-delete':
      return facts.jobActive && facts.filename === input.filename
        ? 'file-in-use'
        : null
    case 'upload':
      return null
    case 'print-start':
      return quiet ? null : job || facts.jobActive ? 'job-active' : 'busy'
    default:
      return 'unsupported-action'
  }
}
