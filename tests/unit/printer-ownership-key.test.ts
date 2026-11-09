import { describe, expect, test } from 'vitest'
import { validPrinterOwnershipKey } from '../../apps/farm/server/storage/postgres-printer-ownership.ts'

describe('printer ownership key', () => {
  test('preserves representable protocol keys exactly', () => {
    expect(validPrinterOwnershipKey('printer-1')).toBe(true)
    expect(validPrinterOwnershipKey('é')).toBe(true)
    expect(validPrinterOwnershipKey('e\u0301')).toBe(true)
    expect(validPrinterOwnershipKey('x'.repeat(128))).toBe(true)
  })
  test('rejects unrepresentable or out-of-contract keys', () => {
    for (const value of ['', 'x'.repeat(129), '\0', '\ud800', '\udc00', 1])
      expect(validPrinterOwnershipKey(value)).toBe(false)
  })
})
