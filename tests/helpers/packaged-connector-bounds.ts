// Fixture-only bounds for reading the packaged Connector dist/ before the
// journey spawns it. The esbuild split output is entry + chunks + extracted
// legal comments + required notices (68 files at the time of writing), so the
// count cap leaves headroom for new chunks while staying finite. The per-file
// and total byte caps are unchanged.
export const PACKAGED_CONNECTOR_LIMITS = {
  files: 96,
  fileBytes: 2 * 1024 * 1024,
  totalBytes: 16 * 1024 * 1024,
} as const

export function assertPackagedListing(
  entries: readonly { isFile(): boolean }[],
): void {
  if (
    entries.length > PACKAGED_CONNECTOR_LIMITS.files ||
    entries.some((entry) => !entry.isFile())
  )
    throw Error('Packaged file bound')
}

export function assertPackagedBytes(
  fileBytes: number,
  totalBytes: number,
): void {
  if (
    fileBytes > PACKAGED_CONNECTOR_LIMITS.fileBytes ||
    totalBytes > PACKAGED_CONNECTOR_LIMITS.totalBytes
  )
    throw Error('Packaged byte bound')
}
