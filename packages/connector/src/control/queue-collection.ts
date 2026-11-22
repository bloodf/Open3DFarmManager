/** State for one printer's completed attempts. The caller must durably save each
 * transition before using it to admit another queue start. */
export type CollectionAttempt = Readonly<{
  id: string
  status: 'awaiting-collection' | 'collected'
}>

export type CollectionState = Readonly<{
  attempts: readonly CollectionAttempt[]
}>

/** Duplicate completion reports retain the original status, including after collection. */
export function observeCompletedAttempt(
  state: CollectionState,
  attemptId: string,
): CollectionState {
  if (!attemptId) throw new Error('Attempt ID is required')
  if (state.attempts.some((attempt) => attempt.id === attemptId)) return state
  return {
    attempts: [...state.attempts, { id: attemptId, status: 'awaiting-collection' }],
  }
}

/** Confirm exactly the observed attempt; an old confirmation cannot clear a newer one. */
export function confirmCollection(
  state: CollectionState,
  attemptId: string,
): CollectionState {
  if (!state.attempts.some((attempt) => attempt.id === attemptId))
    throw new Error('Unknown attempt')
  return {
    attempts: state.attempts.map((attempt) =>
      attempt.id === attemptId ? { ...attempt, status: 'collected' } : attempt,
    ),
  }
}

export function awaitsCollection(state: CollectionState): boolean {
  return state.attempts.some((attempt) => attempt.status === 'awaiting-collection')
}
