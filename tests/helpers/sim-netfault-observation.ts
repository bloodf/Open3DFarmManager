// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict'

export const NETWORK_FAULT_BOUND_MS = 10_000

export type FarmNetworkObservation = {
  elapsedMs: number
  readOnly: boolean
  statusUpdates: number
}

// Callers must supply observations from the farm view, not ICE state or HTTP
// telemetry. A failed transport alone does not prove that the UI is read-only.
export function assertFarmReadOnly(observation: FarmNetworkObservation) {
  assert.ok(observation.elapsedMs >= 0)
  assert.ok(
    observation.elapsedMs <= NETWORK_FAULT_BOUND_MS,
    'read-only within 10 s',
  )
  assert.equal(observation.readOnly, true, 'farm view is read-only')
}

export function assertFarmStatusFlowing(observation: FarmNetworkObservation) {
  assert.ok(observation.elapsedMs >= 0)
  assert.ok(
    observation.elapsedMs <= NETWORK_FAULT_BOUND_MS,
    'status flows within 10 s',
  )
  assert.equal(observation.readOnly, false, 'farm view remains live')
  assert.ok(observation.statusUpdates > 0, 'at least one live status update')
}
