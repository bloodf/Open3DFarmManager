import { describe, expect, test } from 'vitest'
import {
  activeAssignments,
  formatGrams,
  formatMoney,
  inventoryReportHref,
  labelsHref,
  localInputToMs,
  msToLocalInput,
  parseAmount,
  parseThreshold,
  slotLabel,
  usageReportHref,
  validateDrying,
} from '../../apps/farm/app/utils/spool-features-format.ts'
import type { SlotAssignment } from '../../apps/farm/app/utils/spool-features-types.ts'

const FARM = '00000000-0000-4000-8000-000000000539'

function slot(over: Partial<SlotAssignment>): SlotAssignment {
  return {
    id: 'a',
    spoolId: 1,
    printerId: 'p',
    slotKind: 'ams',
    slotIndex: 0,
    assignedAt: 1,
    unassignedAt: null,
    ...over,
  }
}

describe('spool feature formatting', () => {
  test('labels slots from one', () => {
    expect(slotLabel('ams', 0)).toBe('AMS 1')
    expect(slotLabel('toolhead', 2)).toBe('Cabeçote 3')
    expect(slotLabel('printer', 0)).toBe('Impressora 1')
  })

  test('formats grams and money, with dashes for missing values', () => {
    expect(formatGrams(1234.56)).toBe('1.234,6 g')
    expect(formatGrams(null)).toBe('—')
    expect(formatGrams(Number.NaN)).toBe('—')
    expect(formatMoney(12.5, 'BRL')).toContain('12,50')
    expect(formatMoney(null, 'BRL')).toBe('—')
    expect(formatMoney(3, 'not-a-currency')).toBe('3.00 not-a-currency')
  })

  test('keeps only active assignments, sorted by kind then index', () => {
    const list = activeAssignments([
      slot({ id: 'old', unassignedAt: 9 }),
      slot({ id: 'b', slotKind: 'toolhead', slotIndex: 0 }),
      slot({ id: 'c', slotIndex: 2 }),
      slot({ id: 'd', slotIndex: 1 }),
    ])
    expect(list.map((item) => item.id)).toEqual(['d', 'c', 'b'])
  })
})

describe('spool feature input parsing', () => {
  test('accepts decimal comma and rejects junk or out of range', () => {
    expect(parseAmount('12,5', { max: 100 })).toEqual({ ok: true, value: 12.5 })
    expect(parseAmount(' 0 ', { max: 100 })).toEqual({ ok: true, value: 0 })
    expect(parseAmount('abc', { max: 100 }).ok).toBe(false)
    expect(parseAmount('-1', { max: 100 }).ok).toBe(false)
    expect(parseAmount('101', { max: 100 }).ok).toBe(false)
    expect(parseAmount('0', { min: 0.1, max: 100 }).ok).toBe(false)
    expect(parseAmount('', { max: 100 }).ok).toBe(false)
  })

  test('empty threshold means the farm default', () => {
    expect(parseThreshold('')).toEqual({ ok: true, value: null })
    expect(parseThreshold(' 200 ')).toEqual({ ok: true, value: 200 })
    expect(parseThreshold('x').ok).toBe(false)
    expect(parseThreshold('2000000').ok).toBe(false)
  })

  test('datetime-local converts from Sao Paulo wall clock and back', () => {
    const ms = localInputToMs('2026-11-21T09:30')
    expect(ms).toBe(Date.UTC(2026, 10, 21, 12, 30))
    expect(msToLocalInput(ms as number)).toBe('2026-11-21T09:30')
    expect(localInputToMs('')).toBeNull()
    expect(localInputToMs('21/11/2026')).toBeNull()
  })
})

describe('drying form validation', () => {
  const valid = {
    spoolId: '3',
    startedAt: '2026-11-21T08:00',
    endedAt: '2026-11-21T12:00',
    temperature: '55',
    notes: ' Drybox ',
  }

  test('builds the request body', () => {
    const result = validateDrying(valid)
    expect(result).toEqual({
      ok: true,
      body: {
        spoolId: 3,
        startedAt: Date.UTC(2026, 10, 21, 11, 0),
        endedAt: Date.UTC(2026, 10, 21, 15, 0),
        temperatureCelsius: 55,
        notes: 'Drybox',
      },
    })
  })

  test('allows an open session with no notes', () => {
    const result = validateDrying({ ...valid, endedAt: '', notes: '' })
    expect(result.ok && result.body.endedAt).toBeNull()
    expect(result.ok && result.body.notes).toBeNull()
  })

  test('reports each invalid field', () => {
    const result = validateDrying({
      spoolId: '',
      startedAt: '',
      endedAt: '2026-11-21T07:00',
      temperature: '500',
      notes: 'x'.repeat(1025),
    })
    expect(result.ok).toBe(false)
    expect(Object.keys(result.ok ? {} : result.errors).sort()).toEqual([
      'notes',
      'spoolId',
      'startedAt',
      'temperature',
    ])
  })

  test('rejects an end before the start', () => {
    const result = validateDrying({ ...valid, endedAt: '2026-11-21T07:00' })
    expect(result.ok ? '' : result.errors.endedAt).toContain('depois')
  })
})

describe('spool feature links', () => {
  test('builds report and label hrefs for the farm', () => {
    expect(usageReportHref(FARM, 'printer')).toBe(
      `/api/farms/${FARM}/spool-library/reports/usage?groupBy=printer&format=csv`,
    )
    expect(inventoryReportHref(FARM, 'low-stock')).toBe(
      `/api/farms/${FARM}/spool-library/reports/inventory?format=csv&view=low-stock`,
    )
    expect(labelsHref(FARM, [1, 5, 9])).toBe(
      `/api/farms/${FARM}/spool-library/labels?spoolIds=1,5,9`,
    )
  })
})
