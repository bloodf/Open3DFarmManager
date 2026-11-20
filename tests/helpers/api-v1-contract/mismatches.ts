// Documented (operation, status) pairs that no v1 handler can produce today.
// The contract test does not skip them: each carries a probe, the closest
// request the handler accepts, and the test asserts the probe still does NOT
// yield the documented status. When a handler is fixed (or the spec changed)
// the probe starts matching and the test fails until the entry is removed and
// a real scenario takes its place.
//
// Resolved against the OpenAPI walk (real scenarios cover the behaviour):
// - GET /printers/{printerId}/status 400 — malformed id is 404; unknown query ignored
// - GET /jobs/{jobId} 400 — malformed id is 404
// - GET /actions/{actionId} 400 — malformed id is 404
// - every authenticated `500` — unexpected failures are 503 `service-unavailable`
//
// Retry-After on 503 remains listed in the contract test's unsentHeaders; the
// forbidden test file must clear that entry before the shared mapping can send
// the header without failing the absence assertion.
import { type World } from './world.ts'
import { allScenarios, tokenFor } from './scenarios.ts'
import { operations } from './spec.ts'
import { call, type CallInput, type CallResult } from './router.ts'

export interface Mismatch {
  reason: string
  /** Runs the closest reachable request and returns its result. */
  probe: (world: World) => Promise<CallResult>
}

async function authedProbe(
  world: World,
  scopes: Parameters<World['addApp']>[0][number]['scopes'],
  input: CallInput,
) {
  const app = world.addApp([{ scopes }])
  const token = await tokenFor(world, app)
  return call({ ...input, token })
}

// Kept for new probes; no current entry needs a hand-written request.
export const probeHelpers = { authedProbe }

export const mismatches: Record<string, Mismatch> = {}

// Every handler maps an unexpected failure to 503 `service-unavailable`; none
// answers a documented 500 `internal-error`. The probe is that operation's
// dependency-failure scenario. With 500 removed from the spec this loop adds
// nothing; it stays so a reintroduced 500 is pinned again automatically.
for (const op of operations()) {
  if (!op.responses.some((response) => response.status === '500')) continue
  mismatches[`${op.key} 500`] = {
    reason:
      'Unexpected failures are answered 503 service-unavailable; no handler returns 500 internal-error.',
    probe: async (world) => {
      const scenario = allScenarios().find(
        (entry) =>
          entry.op === op.key &&
          entry.status === '503' &&
          !entry.name.startsWith('authorization store'),
      )
      if (!scenario)
        throw new Error(`no dependency-failure scenario for ${op.key}`)
      return (await scenario.run(world)).result
    },
  }
}
