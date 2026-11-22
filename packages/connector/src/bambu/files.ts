import { bambuFtps } from './ftps-ops.ts'
import type { BambuUploadOptions } from './ftps.ts'
import type { BambuFile } from './listing.ts'

export { parseBambuListing, type BambuFile } from './listing.ts'
export type BambuListOptions = Omit<BambuUploadOptions, 'filePath' | 'name'>

export async function listBambuFiles(
  options: BambuListOptions,
): Promise<BambuFile[]> {
  const result = await bambuFtps(options, { op: 'list', folder: 'root' })
  return result.files
}
