import { describe, expect, it } from 'vitest'
import {
  PACKAGED_CONNECTOR_LIMITS as limits,
  assertPackagedBytes,
  assertPackagedListing,
} from '../helpers/packaged-connector-bounds.ts'

const file = { isFile: () => true }
const directory = { isFile: () => false }
const listing = (count: number) => Array.from({ length: count }, () => file)

describe('packaged Connector bounds', () => {
  it('accepts the current split build and the cap itself', () => {
    expect(() => assertPackagedListing(listing(68))).not.toThrow()
    expect(() => assertPackagedListing(listing(limits.files))).not.toThrow()
  })

  it('rejects a listing over the count cap', () => {
    expect(() => assertPackagedListing(listing(limits.files + 1))).toThrow(
      'Packaged file bound',
    )
  })

  it('rejects anything that is not a regular file', () => {
    expect(() => assertPackagedListing([file, directory])).toThrow(
      'Packaged file bound',
    )
  })

  it('keeps the per-file and total byte caps', () => {
    expect(limits.fileBytes).toBe(2 * 1024 * 1024)
    expect(limits.totalBytes).toBe(16 * 1024 * 1024)
    expect(() =>
      assertPackagedBytes(limits.fileBytes, limits.totalBytes),
    ).not.toThrow()
    expect(() => assertPackagedBytes(limits.fileBytes + 1, 0)).toThrow(
      'Packaged byte bound',
    )
    expect(() => assertPackagedBytes(0, limits.totalBytes + 1)).toThrow(
      'Packaged byte bound',
    )
  })
})
