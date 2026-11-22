// spec-derived, not captured: label URL shape comes from apps/farm/server/services/spool-drying.ts
import { expect, test } from 'vitest'
import {
  normalizeLocation,
  parseSpoolLabel,
} from '../../../apps/farm/server/utils/spool-library/finder.ts'
import { FARM, labelFor } from './simulator.ts'

test('reads the spool and farm from a printed label URL', () => {
  expect(parseSpoolLabel(labelFor(12))).toEqual({
    ok: true,
    spoolId: 12,
    farmId: FARM,
  })
  expect(parseSpoolLabel(`  ${labelFor(7)}  `)).toMatchObject({ spoolId: 7 })
})

test('accepts a typed id', () => {
  expect(parseSpoolLabel('#42')).toEqual({
    ok: true,
    spoolId: 42,
    farmId: null,
  })
  expect(parseSpoolLabel('42')).toMatchObject({ ok: true, spoolId: 42 })
})

test.each([
  '',
  '   ',
  '0',
  '#-1',
  'abc',
  'javascript:alert(1)',
  'https://farm.example.invalid/api/farms/not-a-uuid/spool-library/labels/spool/1',
  `https://farm.example.invalid/api/farms/${FARM}/spool-library/labels/spool/1/extra`,
  `https://farm.example.invalid/api/farms/${FARM}/spool-library/labels/spool/99999999999`,
  'x'.repeat(3000),
  42,
  null,
])('refuses %j', (label) => {
  expect(parseSpoolLabel(label)).toEqual({ ok: false })
})

test('normalizes locations', () => {
  expect(normalizeLocation('  Prateleira   A1 ')).toBe('Prateleira A1')
  expect(normalizeLocation('')).toBeNull()
  expect(normalizeLocation('a'.repeat(65))).toBeNull()
  expect(normalizeLocation('linha\nquebrada')).toBeNull()
  expect(normalizeLocation(5)).toBeNull()
})
