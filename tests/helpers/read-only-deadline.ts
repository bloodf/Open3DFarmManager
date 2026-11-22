export const READ_ONLY_DEADLINE_MS = 10_000

/**
 * One deadline for closure and the following visibility check.
 * The timeout passed to `visible` is the time still left, not a fresh budget.
 */
export async function visibleWithinReadOnlyDeadline(
  closedAt: number,
  visible: (timeoutMs: number) => Promise<void>,
  now: () => number = () => performance.now(),
  deadlineMs = READ_ONLY_DEADLINE_MS,
): Promise<number> {
  const remaining = deadlineMs - (now() - closedAt)
  if (!(remaining > 0)) throw new Error('read-only deadline elapsed')
  await visible(remaining)
  const elapsed = now() - closedAt
  if (elapsed > deadlineMs)
    throw new Error('read-only visibility exceeded the deadline')
  return elapsed
}
