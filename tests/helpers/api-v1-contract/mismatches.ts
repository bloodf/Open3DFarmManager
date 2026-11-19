// Documented (operation, status) pairs that no v1 handler can produce today.
// The contract test does not skip them: each carries a probe, the closest
// request the handler accepts, and the test asserts the probe still does NOT
// yield the documented status. When a handler is fixed (or the spec changed)
// the probe starts matching and the test fails until the entry is removed and
// a real scenario takes its place.
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

export const mismatches: Record<string, Mismatch> = {
  'GET /printers/{printerId}/status 400': {
    reason:
      'The handler has no request to reject: a malformed printer id is a 404 from the middleware, and unknown query parameters are ignored.',
    probe: (world) =>
      authedProbe(world, ['printers:read'], {
        method: 'GET',
        path: '/printers/not-a-uuid/status?bogus=1',
      }),
  },
  'GET /jobs/{jobId} 400': {
    reason: 'A malformed job id is answered 404 (service.get), never 400.',
    probe: (world) =>
      authedProbe(world, ['jobs:read'], {
        method: 'GET',
        path: '/jobs/not-a-uuid',
      }),
  },
  'GET /actions/{actionId} 400': {
    reason: 'A malformed action id is answered 404 (service.get), never 400.',
    probe: (world) =>
      authedProbe(world, ['control:basic'], {
        method: 'GET',
        path: '/actions/not-a-uuid',
      }),
  },
}

// Every handler maps an unexpected failure to 503 `service-unavailable`; none
// answers the documented 500 `internal-error`. The probe is that operation's
// dependency-failure scenario.
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
