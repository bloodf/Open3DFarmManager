import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import type { OfflineAuthorityStaleReason } from '../auth/offline-authority.ts'

/** Bound for the append-only audit file. Later events become diagnostics only. */
export const AUTHORITY_AUDIT_MAX_BYTES = 1024 * 1024

/**
 * Durable local audit of every fresh-to-stale offline authority transition.
 * Appends one fsynced JSON line to `<data>/pause-journal/authority-audit.jsonl`
 * (private, no symlink, single link). A failed or full write never restores
 * authority; it only emits `pause-audit-failed`.
 */
export function recordAuthorityStale(
  dataDirectory: string,
  reason: OfflineAuthorityStaleReason,
  onDiagnostic: (value: { kind: 'pause-audit-failed' }) => void,
  now: number = Date.now(),
): void {
  let fd: number | undefined
  try {
    const directory = join(dataDirectory, 'pause-journal')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    fd = openSync(
      join(directory, 'authority-audit.jsonl'),
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_CREAT |
        constants.O_NOFOLLOW,
      0o600,
    )
    const stat = fstatSync(fd)
    const line = JSON.stringify({ at: now, event: 'stale', reason }) + '\n'
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.() ||
      stat.size + Buffer.byteLength(line) > AUTHORITY_AUDIT_MAX_BYTES
    )
      throw new Error('Authority audit unavailable')
    writeSync(fd, line)
    fsyncSync(fd)
  } catch {
    onDiagnostic({ kind: 'pause-audit-failed' })
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
