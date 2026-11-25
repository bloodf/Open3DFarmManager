import { join } from 'node:path'
import type { OfflineAuthorityStaleReason } from '../auth/offline-authority.ts'
import {
  appendPrivateAudit,
  PRIVATE_AUDIT_MAX_BYTES,
} from '../control/private-audit.ts'

/** Bound for one audit file. A full file rotates to `.1`, replacing the older one. */
export const AUTHORITY_AUDIT_MAX_BYTES = PRIVATE_AUDIT_MAX_BYTES

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
  try {
    appendPrivateAudit(
      join(dataDirectory, 'pause-journal'),
      'authority-audit.jsonl',
      JSON.stringify({ at: now, event: 'stale', reason }) + '\n',
    )
  } catch {
    onDiagnostic({ kind: 'pause-audit-failed' })
  }
}
