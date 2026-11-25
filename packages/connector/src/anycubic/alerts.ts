// SPDX-License-Identifier: AGPL-3.0-or-later
// Ported from bloodf/kobracontrol@c414db4f36d4c96f2b232c368ad6cfe56e3d0408
// (GPL-3.0-only, owner-approved reference) src/kobracontrol/kobra.py:
// `CANCEL_CODES`, `succeeded` and `State._on_print`. Wire facts and decision
// rules only; no source text is copied.
//
// `print/report` envelope: {type:'print', action, state, code, msg, data}.
// `stoped` with a fault code is a job the printer ended itself (10111
// "abnormal end of task"); with no code, 0, 200 or 10601 ("user initiated") it
// is a cancel. A pause with a fault code carries the printer's reason.
// The reference marks the Kobra 3 (20024) as experimental: its codes were seen
// on a Kobra X (firmware 2.0.2.8). Nothing here was captured on a Kobra 3, and
// no code table is published, so the printer's own code and text are shown.
import { boundPrinterString } from '../../../farm-protocol/src/string-bounds.ts'

const noFault = new Set<unknown>([undefined, null, 0, 200, 10601])
// Other actions (`getSliceParam`, `update`) are not news about the job.
const jobActions = new Set<unknown>([
  undefined,
  '',
  'start',
  'pause',
  'resume',
  'stop',
  'finish',
  'query',
])

export interface AnycubicAlert {
  kind: 'ended' | 'paused'
  message: string
}

export function isAnycubicFaultCode(code: unknown) {
  return !noFault.has(code)
}

export function anycubicAlert(
  kind: AnycubicAlert['kind'],
  code: unknown,
  msg: unknown,
): AnycubicAlert {
  const lead = `A impressora ${kind === 'ended' ? 'encerrou' : 'pausou'} a impressão`
  const known = Number.isSafeInteger(code) ? ` (código ${code})` : ''
  const detail =
    typeof msg === 'string'
      ? msg.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim()
      : ''
  return {
    kind,
    message: boundPrinterString(
      `${lead}${known}${detail ? `: ${detail}` : '.'}`,
    ),
  }
}

/** Job outcome or fault carried by the envelope of a `print/report`. */
export function readAnycubicPrintReport(envelope: Record<string, unknown>):
  | {
      state: 'finished' | 'idle' | 'error' | 'paused'
      alert?: AnycubicAlert
    }
  | undefined {
  const { type, action, state, code, msg } = envelope
  if (type !== 'print' || !jobActions.has(action)) return
  if (state === 'finished') return { state: 'finished' }
  if (state === 'canceled') return { state: 'idle' }
  if (state === 'stoped')
    return isAnycubicFaultCode(code)
      ? { state: 'error', alert: anycubicAlert('ended', code, msg) }
      : { state: 'idle' }
  if ((state === 'paused' || state === 'pause') && isAnycubicFaultCode(code))
    return { state: 'paused', alert: anycubicAlert('paused', code, msg) }
  return
}
