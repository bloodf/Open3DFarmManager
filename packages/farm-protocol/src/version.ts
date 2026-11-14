/** Inclusive display compatibility range for the readonly status protocol. */
export const SUPPORTED_PROTOCOL_REVISION = { min: 1, max: 1 } as const
export const CONNECTOR_PROTOCOL_REVISION = 1

export function protocolCompatibility(revision: unknown) {
  if (
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  )
    return 'unknown'
  if (revision < SUPPORTED_PROTOCOL_REVISION.min) return 'older'
  if (revision > SUPPORTED_PROTOCOL_REVISION.max) return 'newer'
  return 'supported'
}
