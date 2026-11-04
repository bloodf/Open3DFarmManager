import { test, expect } from 'bun:test'
import fixture from '../fixtures/spoolman/spools.json'
import {
  parseSpoolmanSpools,
  parseSpoolmanVendors,
  parseSpoolmanFilaments,
  SpoolmanReadError,
} from '../../packages/connector/src/spoolman/read.ts'
const context = {
  farmId: '00000000-0000-4000-8000-000000000001',
  serviceId: '00000000-0000-4000-8000-000000000002',
  observedAt: 1000,
  offset: 0,
  limit: 100,
}
const wire = JSON.stringify(fixture)

test('synthetic spool page preserves nulls, archived state and negative remaining weight', () => {
  const result = parseSpoolmanSpools(wire, context)
  expect(result.items.length).toBe(2)
  expect(result.items[0]!.filament.vendor!.name).toBe('Fornecedor sintético')
  expect(result.items[0]!.extra.fixture).toBe('"synthetic"')
  expect(result.items[1]!.remaining_weight).toBe(-5)
  expect(result.items[1]!.used_weight).toBeNull()
  expect(result.items[1]!.archived).toBe(true)
  expect(result.nextOffset).toBeNull()
})
test('origin scope comes only from trusted context and unknown remote fields are discarded', () => {
  const result = parseSpoolmanSpools(
    JSON.stringify([
      {
        ...fixture[0],
        farmId: 'remote',
        device_token: 'REMOTE_SECRET',
        action: 'pause',
      },
    ]),
    context,
  )
  expect(result.farmId).toBe(context.farmId)
  expect(result.serviceId).toBe(context.serviceId)
  expect(JSON.stringify(result)).not.toContain('REMOTE_SECRET')
  const other = parseSpoolmanSpools(wire, {
    ...context,
    serviceId: '00000000-0000-4000-8000-000000000003',
  })
  expect(other.items[0]!.id).toBe(result.items[0]!.id)
  expect(other.serviceId).not.toBe(result.serviceId)
})
test('vendor and filament projections handle absent optional metadata without invented zeroes', () => {
  expect(parseSpoolmanVendors('[{"id":1}]', context).items[0]).toEqual({
    id: 1,
    name: null,
    extra: {},
  })
  const filament = parseSpoolmanFilaments('[{"id":1}]', context).items[0]!
  expect(filament.vendor).toBeNull()
  expect(filament.weight).toBeNull()
  expect(filament.diameter).toBeNull()
})
test('pagination is bounded, handles a final empty page and refuses duplicate IDs', () => {
  expect(
    parseSpoolmanSpools(wire, { ...context, limit: 2, offset: 4 }).nextOffset,
  ).toBe(6)
  expect(
    parseSpoolmanSpools('[]', { ...context, offset: 6 }).nextOffset,
  ).toBeNull()
  expect(() => parseSpoolmanSpools(wire, { ...context, limit: 1 })).toThrow(
    'invalid-page',
  )
  expect(() =>
    parseSpoolmanSpools(wire, { ...context, limit: 2, offset: 10000 }),
  ).toThrow('pagination-limit')
  expect(() =>
    parseSpoolmanSpools(JSON.stringify([fixture[0], fixture[0]]), context),
  ).toThrow('duplicate-id')
})
test('malformed numbers, references and absent archival state reject the whole page', () => {
  for (const change of [
    { id: 0 },
    { id: Number.MAX_SAFE_INTEGER + 1 },
    { used_weight: -1 },
    { used_weight: '250' },
    { filament: null },
    { archived: undefined },
    { location: 'bad\u0000value' },
  ])
    expect(() =>
      parseSpoolmanSpools(
        JSON.stringify([{ ...fixture[0], ...change }]),
        context,
      ),
    ).toThrow('invalid-page')
  expect(() =>
    parseSpoolmanSpools(wire.replace('750', '1e309'), context),
  ).toThrow('invalid-page')
  expect(() =>
    parseSpoolmanSpools(
      JSON.stringify([
        { ...fixture[0], filament: { id: 2, color_hex: '<script>' } },
      ]),
      context,
    ),
  ).toThrow('invalid-page')
})
test('extra values are bounded opaque strings, not arbitrary executable or nested data', () => {
  for (const extra of [
    { value: { nested: true } },
    { value: 'x'.repeat(4097) },
    Object.fromEntries(
      Array.from({ length: 33 }, (_, i) => ['field' + i, 'x']),
    ),
    JSON.parse('{"__proto__":"x"}'),
  ])
    expect(() =>
      parseSpoolmanSpools(JSON.stringify([{ ...fixture[0], extra }]), context),
    ).toThrow('invalid-page')
  expect(({} as Record<string, unknown>).polluted).toBeUndefined()
})
test('invalid envelopes and oversized Unicode produce redacted local errors', () => {
  for (const data of ['null', '{}', '{', '{"error":"REMOTE_SECRET"}']) {
    try {
      parseSpoolmanSpools(data, context)
      throw new Error('Unexpected success')
    } catch (error) {
      expect(error).toBeInstanceOf(SpoolmanReadError)
      expect(String(error)).not.toContain('REMOTE_SECRET')
    }
  }
  expect(() => parseSpoolmanSpools('é'.repeat(131073), context)).toThrow(
    'frame-too-large',
  )
  for (const change of [
    { limit: 0 },
    { limit: 201 },
    { offset: -1 },
    { offset: 10001 },
    { observedAt: NaN },
    { serviceId: 'remote' },
  ])
    expect(() => parseSpoolmanSpools(wire, { ...context, ...change })).toThrow(
      'invalid-context',
    )
})
