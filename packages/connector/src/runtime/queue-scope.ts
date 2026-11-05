import {
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  linkSync,
  unlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import { canonicalize } from '../../../farm-protocol/src/canonical.ts'
import { TelemetryQueue } from '../cloud/queue.ts'
import { readPrivateJsonFile } from '../config/local.ts'
import type { AgentRuntimeConfig } from '../config/runtime.ts'
import type { RuntimeCredential } from '../config/credential.ts'

const RECEIPT = 'scope.json'
const PENDING = 'scope.pending'
const present = (path: string) =>
  lstatSync(path, { throwIfNoEntry: false }) !== undefined
function syncDirectory(path: string) {
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

export function assertUnscopedCollection(directory: string): void {
  if (present(join(directory, RECEIPT)) || present(join(directory, PENDING)))
    throw new Error('Standalone collection cannot use a scoped queue')
}

/** Receipt absence never authorizes adoption of a previously initialized queue. */
export function openScopedTelemetryQueue(input: {
  dataDirectory: string
  config: AgentRuntimeConfig
  credential: RuntimeCredential
  now: number
}): TelemetryQueue {
  const directory = join(input.dataDirectory, 'telemetry')
  const receipt = join(directory, RECEIPT)
  const pending = join(directory, PENDING)
  const expected = canonicalize({
    version: 1,
    farm_id: input.credential.farm_id,
    agent_id: input.credential.agent_id,
    fingerprint: input.credential.expectedFingerprint,
    assignments: [...input.config.assignments].sort((left, right) =>
      left.assignment_id < right.assignment_id
        ? -1
        : left.assignment_id > right.assignment_id
          ? 1
          : 0,
    ),
  })
  function verify() {
    if (
      present(pending) ||
      canonicalize(readPrivateJsonFile(receipt, { maxBytes: 64 * 1024 })) !==
        expected
    )
      throw new Error('Queue scope requires operator review')
  }
  const existing = lstatSync(directory, { throwIfNoEntry: false })
  if (existing) {
    if (
      !existing.isDirectory() ||
      process.platform === 'win32' ||
      existing.uid !== process.getuid?.() ||
      (existing.mode & 0o077) !== 0
    )
      throw new Error('Invalid scoped queue directory')
    // This happens before recovery can expire, truncate or compact any old data.
    verify()
  } else {
    // Exclusive directory creation rejects a competing initializer, even an empty one.
    mkdirSync(directory, { mode: 0o700 })
    syncDirectory(input.dataDirectory)
    for (const name of [
      'telemetry.jsonl',
      'telemetry.lock',
      'telemetry.compact',
      RECEIPT,
      PENDING,
    ]) {
      if (present(join(directory, name)))
        throw new Error('Queue initialization requires operator review')
    }
  }
  const queue = new TelemetryQueue(
    directory,
    input.now,
    {},
    {
      beforeRecovery: () => {
        if (existing) verify()
        else {
          for (const name of [
            'telemetry.jsonl',
            'telemetry.compact',
            RECEIPT,
            PENDING,
          ]) {
            if (present(join(directory, name)))
              throw new Error('Queue initialization requires operator review')
          }
        }
        return undefined
      },
    },
  )
  try {
    if (!existing) {
      if (
        queue.depth !== 0 ||
        queue.recovery.expired ||
        queue.recovery.capacity ||
        queue.recovery.partialTail
      )
        throw new Error('New scoped queue is not durably empty')
      const fd = openSync(
        pending,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      )
      try {
        writeFileSync(fd, expected + '\n')
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      syncDirectory(directory)

      // Publish the complete fsynced inode atomically without replacing any receipt.
      // An interruption leaving both links/marker always requires operator review.
      linkSync(pending, receipt)
      syncDirectory(directory)
      unlinkSync(pending)
      syncDirectory(directory)
      verify()
    }
    return queue
  } catch (error) {
    queue.close()
    throw error
  }
}
