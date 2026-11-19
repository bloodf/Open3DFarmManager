/** Link between a finished job and the library version that was printed (#385). */
export interface JobLibraryLink {
  librarySha256: string
  plate?: number
}

const sha256 = /^[0-9a-f]{64}$/

/**
 * Reads the optional link a Connector adds to `lastJob`. A job without a valid
 * hash is unlinked; a plate never stands alone, so jobs imported from printer
 * history or started outside the library keep no link at all.
 */
export function jobLibraryLink(last: {
  sha256?: string | undefined
  plate?: number | undefined
}): JobLibraryLink | undefined {
  if (typeof last.sha256 !== 'string' || !sha256.test(last.sha256))
    return undefined
  const plate =
    Number.isInteger(last.plate) && last.plate! >= 1 && last.plate! <= 1000
      ? last.plate
      : undefined
  return {
    librarySha256: last.sha256,
    ...(plate === undefined ? {} : { plate }),
  }
}
