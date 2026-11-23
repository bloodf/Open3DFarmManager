// SPDX-License-Identifier: MIT
import type { ReplayResult } from './replay-view.ts'

/** Keeps uncertain replay outcomes until resolved or checked by the operator. */
export function createReplayOutcomeLocks() {
  const locks = new Map<string, ReplayResult>()

  return {
    get(itemId: string): ReplayResult | null {
      return locks.get(itemId) ?? null
    },
    record(itemId: string, result: ReplayResult) {
      if (result.outcome === 'outcome-unknown') locks.set(itemId, result)
      else locks.delete(itemId)
    },
    confirmPrinterChecked(itemId: string) {
      locks.delete(itemId)
    },
  }
}

export const replayOutcomeLocks = createReplayOutcomeLocks()
