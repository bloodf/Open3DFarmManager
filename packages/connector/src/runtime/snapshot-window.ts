/** How long one observation stays valid in the farm snapshot. */
export const SNAPSHOT_VALIDITY_MS = 5000

// A read-only vendor observation is replaced only after the next pause plus the
// next requests, so both together must stay inside the validity window.
export const READ_ONLY_POLL_MS = SNAPSHOT_VALIDITY_MS / 5
const PUBLISH_MARGIN_MS = 500
/** Time one poll may spend on all of its requests. */
export const READ_ONLY_POLL_BUDGET_MS =
  SNAPSHOT_VALIDITY_MS - READ_ONLY_POLL_MS - PUBLISH_MARGIN_MS
