// Allow modest Connector clock skew without letting a far-future report
// become the ordering watermark for later reports.
export const MAX_FUTURE_OBSERVATION_MS = 30_000
