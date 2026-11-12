import assert from 'node:assert/strict'
import { unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { systemLockProbe } from '../../packages/connector/src/cloud/queue-lock.ts'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'

/** Automatic takeover needs machine, boot and PID-namespace identities (Linux). */
export const automaticLockRecovery =
  systemLockProbe.machineId() !== undefined &&
  systemLockProbe.boot() !== undefined &&
  systemLockProbe.pidNamespace() !== undefined

/**
 * Reopens a queue whose owner was SIGKILLed and reaped by the caller: automatic
 * takeover where supported, otherwise a fail-closed open followed by the
 * documented operator step for this exact lock.
 */
export function reopenAfterCrash(directory: string, now: number) {
  if (!automaticLockRecovery) {
    assert.throws(() => new TelemetryQueue(directory, now), /EEXIST/)
    unlinkSync(join(directory, 'telemetry.lock'))
  }
  const queue = new TelemetryQueue(directory, now)
  assert.equal(queue.recoveredStaleLock, automaticLockRecovery)
  return queue
}
