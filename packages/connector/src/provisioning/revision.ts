import { createJournal } from './journal.ts'

/**
 * Read-only durable configuration revision for the signalling advertisement.
 * Mirrors the engine's normalization of a commit whose state update was
 * interrupted, without writing. Returns null when the journal is unreadable.
 */
export function readDurableRevision(stateDirectory: string): number | null {
  try {
    const journal = createJournal(stateDirectory)
    const state = journal.readState()
    const active = state.active ? journal.readOperation(state.active) : null
    if (
      active?.plan &&
      (active.stage === 'local-committed' ||
        active.stage === 'inventory-confirmed')
    )
      return Math.max(state.revision, active.plan.committed_revision)
    return state.revision
  } catch {
    return null
  }
}
