// Documented (operation, status) pairs that no v1 handler can produce today.
// Empty when the OpenAPI walk and handlers agree. A new mismatch needs a probe
// that asserts the documented status is still unreachable; remove the entry
// once a real scenario covers it.
import { type CallResult } from './router.ts'
import { type World } from './world.ts'

export interface Mismatch {
  reason: string
  /** Runs the closest reachable request and returns its result. */
  probe: (world: World) => Promise<CallResult>
}

export const mismatches: Record<string, Mismatch> = {}
