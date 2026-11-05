/** Prototype policy: server and endpoint wall clocks must be synchronized within
 * 250 ms. This guard has no expiry grace and may deny legitimately skewed hosts. */
export const SIGNALLING_CLOCK_SKEW_MS = 250
export interface SignallingClock {
  wall(): number
  monotonic(): number
}
export interface SignallingClockSample {
  readonly wall: number
  readonly monotonic: number
}
export interface SignallingReadBudget {
  readonly observedAt: number
  readonly validUntil: number
  readonly monotonicDeadline: number
}
export function signallingClockSample(
  clock: SignallingClock,
): SignallingClockSample {
  const sample = { wall: clock.wall(), monotonic: clock.monotonic() }
  if (
    !Number.isSafeInteger(sample.wall) ||
    sample.wall < 0 ||
    !Number.isFinite(sample.monotonic) ||
    sample.monotonic < 0
  )
    throw new Error('Invalid signalling clock')
  return sample
}
function elapsed(
  start: SignallingClockSample,
  end: SignallingClockSample,
): number {
  const duration = end.monotonic - start.monotonic
  const wallDuration = end.wall - start.wall
  if (
    duration < 0 ||
    wallDuration < 0 ||
    Math.abs(duration - wallDuration) > SIGNALLING_CLOCK_SKEW_MS
  )
    throw new Error('Signalling clock discontinuity')
  return duration
}
/** Start must be taken before BEGIN, end after COMMIT. Subtract the entire
 * transaction duration, even though the DB observation is its final sample. */
export function signallingReadBudget(input: {
  start: SignallingClockSample
  end: SignallingClockSample
  observedAt: number
  validUntil: number
}): SignallingReadBudget {
  const { start, end, observedAt, validUntil } = input
  const duration = elapsed(start, end)
  if (
    !Number.isSafeInteger(observedAt) ||
    !Number.isSafeInteger(validUntil) ||
    observedAt < 0 ||
    validUntil <= observedAt ||
    observedAt < start.wall - SIGNALLING_CLOCK_SKEW_MS ||
    observedAt > end.wall + SIGNALLING_CLOCK_SKEW_MS
  )
    throw new Error('Invalid signalling DB time interval')
  const remaining = validUntil - observedAt - Math.ceil(duration)
  if (remaining <= 0)
    throw new Error('Signalling authorization expired in transit')
  return {
    observedAt,
    validUntil,
    monotonicDeadline: end.monotonic + remaining,
  }
}
/** Revalidation only shortens the fixed context deadline. It cannot renew it. */
export function signallingRemaining(input: {
  anchor: SignallingClockSample
  now: SignallingClockSample
  authorization: SignallingReadBudget
  previousDeadline?: number
}): { remaining: number; monotonicDeadline: number } {
  elapsed(input.anchor, input.now)
  const deadline = Math.min(
    input.anchor.monotonic + 30_000,
    input.authorization.monotonicDeadline,
    input.previousDeadline ?? Number.POSITIVE_INFINITY,
  )
  const remaining = Math.floor(deadline - input.now.monotonic)
  if (remaining <= 0) throw new Error('Signalling authorization expired')
  return { remaining, monotonicDeadline: deadline }
}
/** Endpoint policy uses one request interval, not that interval plus another RTT.
 * The endpoint must also arm its own monotonic deadline before awaiting crypto. */
export function checkSignallingWireClock(input: {
  requestStart: SignallingClockSample
  responseEnd: SignallingClockSample
  issuedAt: number
  expiresAt: number
}): number {
  const duration = elapsed(input.requestStart, input.responseEnd)
  if (
    !Number.isSafeInteger(input.issuedAt) ||
    !Number.isSafeInteger(input.expiresAt) ||
    input.issuedAt < input.requestStart.wall - SIGNALLING_CLOCK_SKEW_MS ||
    input.issuedAt > input.responseEnd.wall + SIGNALLING_CLOCK_SKEW_MS ||
    input.expiresAt <= input.issuedAt ||
    input.expiresAt - input.issuedAt > 30_000
  )
    throw new Error('Invalid signalling wire clock')
  const remaining = Math.floor(
    Math.min(
      input.expiresAt - input.responseEnd.wall,
      input.expiresAt - input.issuedAt - Math.ceil(duration),
      30_000 - Math.ceil(duration),
    ),
  )
  if (remaining <= 0) throw new Error('Signalling response expired in transit')
  return input.responseEnd.monotonic + remaining
}
