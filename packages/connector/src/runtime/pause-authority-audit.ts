import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import type { OfflineAuthorityStaleReason } from '../auth/offline-authority.ts'

/** Bound for one audit file. A full file rotates to `.1`, replacing the older one. */
export const AUTHORITY_AUDIT_MAX_BYTES = 1024 * 1024

function privateOwned(stat: { mode: number; uid: number }): boolean {
  return (
    process.platform === 'win32' ||
    ((stat.mode & 0o077) === 0 && stat.uid === process.getuid?.())
  )
}

/**
 * Durable local audit of every fresh-to-stale offline authority transition.
 * Appends one fsynced JSON line to `<data>/pause-journal/authority-audit.jsonl`.
 * The directory must be a private, owned, real directory; the file must be a
 * private single-link regular file. A failed write never restores authority;
 * it only emits `pause-audit-failed`.
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
    const entry = lstatSync(directory)
    if (!entry.isDirectory() || !privateOwned(entry))
      throw new Error('Authority audit directory is not private')
    const path = join(directory, 'authority-audit.jsonl')
    const line = JSON.stringify({ at: now, event: 'stale', reason }) + '\n'
    const open = () =>
      openSync(
        path,
        constants.O_WRONLY |
          constants.O_APPEND |
          constants.O_CREAT |
          constants.O_NOFOLLOW,
        0o600,
      )
    fd = open()
    let stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || !privateOwned(stat))
      throw new Error('Authority audit unavailable')
    if (stat.size + Buffer.byteLength(line) > AUTHORITY_AUDIT_MAX_BYTES) {
      closeSync(fd)
      fd = undefined
      renameSync(path, path + '.1')
      fd = open()
      stat = fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1 || !privateOwned(stat))
        throw new Error('Authority audit unavailable')
    }
    writeSync(fd, line)
    fsyncSync(fd)
  } catch {
    onDiagnostic({ kind: 'pause-audit-failed' })
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
