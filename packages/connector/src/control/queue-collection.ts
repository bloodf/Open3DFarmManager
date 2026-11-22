/** State for one printer's completed attempts. The caller must durably save each
 * transition before using it to admit another queue start. */
export type CollectionAttempt = Readonly<{
  id: string
  status: 'awaiting-collection' | 'collected'
}>

export type CollectionState = Readonly<{
  attempts: readonly CollectionAttempt[]
  /** Wall time (ms) OpenFarm last sent a start; the next finished run after it is held. */
  dispatchedAt?: number | undefined
}>

/** Duplicate completion reports retain the original status, including after collection. */
export function observeCompletedAttempt(
  state: CollectionState,
  attemptId: string,
): CollectionState {
  if (!attemptId) throw new Error('Attempt ID is required')
  if (state.attempts.some((attempt) => attempt.id === attemptId)) return state
  return {
    ...state,
    attempts: [
      ...state.attempts,
      { id: attemptId, status: 'awaiting-collection' },
    ],
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
    ...state,
    attempts: state.attempts.map((attempt) =>
      attempt.id === attemptId ? { ...attempt, status: 'collected' } : attempt,
    ),
  }
}

export function awaitsCollection(state: CollectionState): boolean {
  return state.attempts.some(
    (attempt) => attempt.status === 'awaiting-collection',
  )
}

/** Remember an OpenFarm start; the run it began is held when it finishes. */
export function observeDispatch(
  state: CollectionState,
  wallMs: number,
): CollectionState {
  if (!Number.isSafeInteger(wallMs) || wallMs < 0)
    throw new Error('Invalid dispatch time')
  return { ...state, dispatchedAt: wallMs }
}

/**
 * A finished run observed on the printer. Only a run that ended after an
 * OpenFarm start becomes an attempt; repeats of the same end time are no-ops.
 */
export function observeFinishedRun(
  state: CollectionState,
  endedAt: number,
): CollectionState {
  if (!Number.isSafeInteger(endedAt) || endedAt < 0)
    throw new Error('Invalid end time')
  const attemptId = String(endedAt)
  if (state.attempts.some((attempt) => attempt.id === attemptId)) return state
  if (state.dispatchedAt === undefined || endedAt < state.dispatchedAt)
    return state
  const { dispatchedAt: _consumed, ...rest } = state
  return observeCompletedAttempt(rest, attemptId)
}

/** The attempts still on the bed, oldest first. */
export function awaitingAttempts(state: CollectionState): readonly string[] {
  return state.attempts
    .filter((attempt) => attempt.status === 'awaiting-collection')
    .map((attempt) => attempt.id)
}

/**
 * The operator cleared the plate after seeing the run that ended at `endedAt`:
 * every awaiting attempt that ended then or earlier is collected. A run that
 * ended later stays held, so an old confirmation never clears a newer one.
 */
export function confirmCollectionThrough(
  state: CollectionState,
  endedAt: number,
): CollectionState {
  if (!Number.isSafeInteger(endedAt) || endedAt < 0)
    throw new Error('Invalid end time')
  return {
    ...state,
    attempts: state.attempts.map((attempt) =>
      attempt.status === 'awaiting-collection' &&
      /^\d{1,16}$/.test(attempt.id) &&
      Number(attempt.id) <= endedAt
        ? { ...attempt, status: 'collected' }
        : attempt,
    ),
  }
}
