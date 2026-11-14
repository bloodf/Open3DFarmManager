import type { ControlResultCode } from '../../../farm-protocol/src/control-actions.ts'

/**
 * Firmware "authorization control" detection for Bambu LAN commands.
 *
 * Sources:
 * - Bambu Lab, "Firmware Update Introducing New Authorization Control System"
 *   (Jan 2025): critical MQTT operations (print control, temperature, fan,
 *   light, start print) need authorization unless the printer runs LAN-only
 *   mode with Developer Mode enabled.
 *   https://blog.bambulab.com/firmware-update-introducing-new-authorization-control-system-2/
 * - Bambu Lab wiki, "Third-party integration" (Developer Mode keeps MQTT, live
 *   stream and FTP open). https://wiki.bambulab.com/en/software/third-party-integration
 * - Community protocol notes (OpenBambuAPI mqtt.md, ha-bambulab): the printer
 *   echoes the request on device/<serial>/report with the same `command` and
 *   `sequence_id` plus `result`/`reason`; an unsigned command on authorized
 *   firmware is answered with result "failed", reason "mqtt message verify
 *   failed" and err_code 84033543.
 *
 * Everything here is pure: no transport, clock or simulator.
 */
export const BAMBU_AUTHORIZATION_REQUIRED =
  'bambu-authorization-required' satisfies ControlResultCode

/** err_code of "MQTT command verification failed" (0x05024007). */
export const BAMBU_VERIFY_FAILED_ERR_CODE = 84033543

export type BambuSentRequest = Readonly<{ command: string; sequenceId: string }>
/**
 * `none`: the report does not answer this request.
 * `acknowledged`: the printer echoed the request without a failure.
 * `failed`: the printer refused for a reason unrelated to authorization.
 * `authorization-required`: the refusal matches firmware authorization control.
 */
export type BambuReply =
  'none' | 'acknowledged' | 'failed' | 'authorization-required'

const AUTHORIZATION_REASON =
  /verif|authori[sz]|signature|unsigned|permission|developer mode/i

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Identity of the request built by commands.ts, whatever its top-level key. */
export function sentBambuRequest(payload: unknown): BambuSentRequest | null {
  for (const value of Object.values(record(payload) ?? {})) {
    const request = record(value)
    if (
      request &&
      typeof request.command === 'string' &&
      typeof request.sequence_id === 'string'
    )
      return Object.freeze({
        command: request.command,
        sequenceId: request.sequence_id,
      })
  }
  return null
}

/** Classifies one decoded report against the single request of an attempt. */
export function classifyBambuReply(
  report: unknown,
  sent: BambuSentRequest,
): BambuReply {
  let reply: BambuReply = 'none'
  for (const value of Object.values(record(report) ?? {})) {
    const echo = record(value)
    if (
      !echo ||
      echo.command !== sent.command ||
      echo.sequence_id !== sent.sequenceId
    )
      continue
    const result =
      typeof echo.result === 'string' ? echo.result.toLowerCase() : ''
    const reason = typeof echo.reason === 'string' ? echo.reason : ''
    const verifyFailed = echo.err_code === BAMBU_VERIFY_FAILED_ERR_CODE
    if (!verifyFailed && !result.startsWith('fail')) {
      if (reply === 'none') reply = 'acknowledged'
      continue
    }
    if (verifyFailed || AUTHORIZATION_REASON.test(reason))
      return 'authorization-required'
    reply = 'failed'
  }
  return reply
}

/** Keeps the strongest reply seen during one attempt. */
export function mergeBambuReply(
  previous: BambuReply,
  next: BambuReply,
): BambuReply {
  const rank: Record<BambuReply, number> = {
    none: 0,
    acknowledged: 1,
    failed: 2,
    'authorization-required': 3,
  }
  return rank[next] > rank[previous] ? next : previous
}

/**
 * The hint applies when the printer said so, or when it acknowledged a
 * lifecycle request and its print state still had not changed by the existing
 * timeout: authorized firmware accepts the frame and silently ignores it.
 */
export function bambuAuthorizationRequired(input: {
  reply: BambuReply
  lifecycle: boolean
  timedOut: boolean
  targetReached: boolean
}): boolean {
  if (input.reply === 'authorization-required') return true
  return (
    input.reply === 'acknowledged' &&
    input.lifecycle &&
    input.timedOut &&
    !input.targetReached
  )
}

/** Carries the wire result code; never carries printer text or credentials. */
export class BambuAuthorizationRequired extends Error {
  readonly code = 'BAMBU_AUTHORIZATION_REQUIRED'
  readonly resultCode: ControlResultCode = BAMBU_AUTHORIZATION_REQUIRED
  constructor() {
    super('Bambu firmware authorization required')
  }
}
