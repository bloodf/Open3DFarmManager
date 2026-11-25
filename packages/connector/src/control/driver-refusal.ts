/** Why a driver refused a command before writing anything to the printer. */
export type DriverRefusalReason =
  'state' | 'unsupported-action' | 'invalid-command'

/**
 * The one typed pre-write refusal of every command builder and driver. The
 * dispatchers trust only this class, and only before the write guard, to record
 * a command as not sent. Never throw it once a write may have started: any
 * other error there is an unknown outcome.
 */
export class DriverRefusalError extends Error {
  readonly userMessage: string | undefined
  readonly refusal: DriverRefusalReason
  constructor(
    refusal: DriverRefusalReason,
    message: string,
    options?: ErrorOptions & { userMessage?: string },
  ) {
    super(message, options)
    this.userMessage = options?.userMessage
    this.refusal = refusal
  }
}
