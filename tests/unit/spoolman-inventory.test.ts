import { expect, test } from 'vitest'
import {
  parseSpoolmanSpoolInventory,
  SpoolmanReadError,
} from '../../packages/connector/src/spoolman/read.ts'
const context = {
  farmId: '00000000-0000-4000-8000-000000000001',
  serviceId: '00000000-0000-4000-8000-000000000002',
  limit: 2,
}
const spool = (id: number) => ({ id, filament: { id: 1 }, archived: false })
const page = (offset: number, ids: number[], observedAt = 1000 + offset) => ({
  offset,
  observedAt,
  wire: JSON.stringify(ids.map(spool)),
})

test('collects complete observed traversal with one trusted scope and time interval', () => {
  const input = [page(0, [1, 2]), page(2, [3])]
  const before = JSON.stringify(input)
  const result = parseSpoolmanSpoolInventory(input, context)
  expect(result.items.map((item) => item.id)).toEqual([1, 2, 3])
  expect(result.farmId).toBe(context.farmId)
  expect(result.serviceId).toBe(context.serviceId)
  expect([result.observedFrom, result.observedThrough]).toEqual([1000, 1002])
  expect(JSON.stringify(input)).toBe(before)
})

test('requires an explicit final empty page after a full page', () => {
  expect(() => parseSpoolmanSpoolInventory([page(0, [1, 2])], context)).toThrow(
    'incomplete-inventory',
  )
  expect(
    parseSpoolmanSpoolInventory([page(0, [1, 2]), page(2, [])], context).items,
  ).toHaveLength(2)
  expect(parseSpoolmanSpoolInventory([page(0, [])], context).items).toEqual([])
  expect(() => parseSpoolmanSpoolInventory([], context)).toThrow(
    'incomplete-inventory',
  )
})

test('rejects repeated IDs across otherwise valid pages', () => {
  expect(() =>
    parseSpoolmanSpoolInventory([page(0, [1, 2]), page(2, [1])], context),
  ).toThrow('duplicate-id')
})

test('rejects skipped, repeated, nonzero initial and trailing page offsets', () => {
  for (const pages of [
    [page(1, [])],
    [page(0, [1, 2]), page(3, [])],
    [page(0, [1, 2]), page(0, [])],
    [page(0, [1]), page(1, [])],
  ])
    expect(() => parseSpoolmanSpoolInventory(pages, context)).toThrow(
      'invalid-sequence',
    )
})

test('rejects backwards observation time and invalid scope metadata', () => {
  expect(() =>
    parseSpoolmanSpoolInventory([page(0, [1, 2]), page(2, [], 999)], context),
  ).toThrow('invalid-sequence')
  expect(() =>
    parseSpoolmanSpoolInventory([page(0, [])], {
      ...context,
      serviceId: 'remote',
    }),
  ).toThrow('invalid-context')
  expect(() =>
    parseSpoolmanSpoolInventory([{ ...page(0, []), offset: NaN }], context),
  ).toThrow('invalid-sequence')
})

test('remote scope and secret-like fields never enter the projected inventory', () => {
  const wire = JSON.stringify([
    {
      ...spool(1),
      farmId: 'remote',
      serviceId: 'remote',
      device_token: 'SYNTHETIC_SECRET',
    },
  ])
  const result = parseSpoolmanSpoolInventory(
    [{ offset: 0, observedAt: 1, wire }],
    context,
  )
  expect(result.farmId).toBe(context.farmId)
  expect(result.serviceId).toBe(context.serviceId)
  expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET')
})

test('a bad later page rejects the complete traversal with a redacted local error', () => {
  try {
    parseSpoolmanSpoolInventory(
      [
        page(0, [1, 2]),
        { offset: 2, observedAt: 1002, wire: '{"SYNTHETIC_SECRET":' },
      ],
      context,
    )
    throw new Error('Unexpected success')
  } catch (error) {
    expect(error).toBeInstanceOf(SpoolmanReadError)
    expect(String(error)).not.toContain('SYNTHETIC_SECRET')
  }
})

test('bounds page count and total inventory size', () => {
  expect(() =>
    parseSpoolmanSpoolInventory(
      Array.from({ length: 257 }, () => page(0, [])),
      context,
    ),
  ).toThrow('inventory-limit')
  const pages = Array.from({ length: 50 }, (_, offset) =>
    page(
      offset * 200,
      Array.from({ length: 200 }, (_, i) => offset * 200 + i + 1),
    ),
  )
  pages.push(page(10_000, [10_001]))
  expect(() =>
    parseSpoolmanSpoolInventory(pages, { ...context, limit: 200 }),
  ).toThrow('inventory-limit')
})

test('bounds aggregate bytes even when each individual page is valid', () => {
  const extra = Object.fromEntries(
    Array.from({ length: 31 }, (_, i) => [`k${i}`, 'x'.repeat(4096)]),
  )
  const pages = Array.from({ length: 18 }, (_, offset) => ({
    offset,
    observedAt: offset,
    wire: JSON.stringify([
      { ...spool(offset + 1), extra, filament: { id: 1, extra } },
    ]),
  }))
  expect(pages.every((item) => Buffer.byteLength(item.wire) < 256 * 1024)).toBe(
    true,
  )
  expect(() =>
    parseSpoolmanSpoolInventory(pages, { ...context, limit: 1 }),
  ).toThrow('inventory-limit')
})
