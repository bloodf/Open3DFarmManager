import { describe, expect, test } from 'vitest'
import {
  buildFilamentQuery,
  buildSpoolQuery,
  buildVendorQuery,
  distinctMaterials,
  EMPTY_FILAMENT_FILTERS,
  EMPTY_SPOOL_FILTERS,
  EMPTY_VENDOR_FILTERS,
  estimateAfterMeasure,
  estimateAfterUse,
  extractApiError,
  filamentColorLabel,
  filamentDisplayTitle,
  filamentSwatchBackground,
  formatPrice,
  formatSpoolLength,
  formatSpoolWeight,
  normalizeColorHex,
  parseMultiColorHexes,
  reportRows,
  spoolDisplayTitle,
  spoolRemainingPercent,
  validateFilamentForm,
  validateImportForm,
  validateSpoolForm,
  validateVendorForm,
} from '../../apps/farm/app/utils/spool-library-format.ts'
import type {
  FilamentItem,
  ImportReport,
  SpoolItem,
} from '../../apps/farm/app/utils/spool-library-types.ts'

const sampleFilament: FilamentItem = {
  id: 10,
  registered: '2026-11-20T12:00:00Z',
  name: 'Galaxy Black',
  vendor: {
    id: 2,
    registered: '2026-11-19T12:00:00Z',
    name: 'Prusament',
    empty_spool_weight: 200,
    extra: {},
  },
  material: 'PLA',
  density: 1.24,
  diameter: 1.75,
  weight: 1000,
  spool_weight: 210,
  price: 149.9,
  color_hex: '1A2B3C',
  extra: {},
}

const sampleSpool: SpoolItem = {
  id: 7,
  registered: '2026-11-20T13:00:00Z',
  filament: sampleFilament,
  initial_weight: 1000,
  spool_weight: 210,
  used_weight: 250,
  remaining_weight: 750,
  used_length: 83823,
  remaining_length: 251470,
  location: 'Estante A',
  lot_nr: 'L42',
  archived: false,
  extra: {},
}

describe('spool-library color and formatting utilities', () => {
  test('normalizes single and multi-color hex values and computes swatch backgrounds', () => {
    expect(normalizeColorHex('#ff00aa')).toBe('FF00AA')
    expect(normalizeColorHex('12345678')).toBe('12345678')
    expect(normalizeColorHex('xyz')).toBeNull()

    expect(parseMultiColorHexes('ff0000, #00ff00')).toEqual([
      'FF0000',
      '00FF00',
    ])
    expect(parseMultiColorHexes('ff0000')).toEqual([])

    expect(filamentSwatchBackground({ color_hex: '1A2B3C' })).toBe('#1A2B3C')
    expect(
      filamentSwatchBackground({
        multi_color_hexes: 'FF0000,0000FF',
        multi_color_direction: 'coaxial',
      }),
    ).toBe('linear-gradient(90deg, #FF0000, #0000FF)')
    expect(
      filamentColorLabel({
        multi_color_hexes: 'FF0000,0000FF',
        multi_color_direction: 'longitudinal',
      }),
    ).toBe('#FF0000, #0000FF (longitudinal)')
    expect(filamentColorLabel({})).toBe('Sem cor')
  })

  test('formats titles, weights, lengths, prices, and remaining percentage', () => {
    expect(filamentDisplayTitle(sampleFilament)).toBe(
      'Prusament · Galaxy Black',
    )
    expect(spoolDisplayTitle(sampleSpool)).toBe('Prusament · Galaxy Black')
    expect(spoolRemainingPercent(sampleSpool)).toBe(75)
    expect(formatSpoolWeight(750)).toContain('750')
    expect(formatSpoolWeight(-12.5)).toContain('-12,5')
    expect(formatSpoolWeight(undefined)).toBe('—')
    expect(formatSpoolLength(251470)).toBe('251,5 m')
    expect(formatPrice(149.9)).toBe('149,90')
    expect(distinctMaterials([sampleSpool])).toEqual(['PLA'])
  })

  test('estimates remaining weight after use (weight and length) and measure', () => {
    const byWeight = estimateAfterUse(sampleSpool, 'weight', 50)
    expect(byWeight).not.toBeNull()
    expect(byWeight?.deltaGrams).toBe(50)
    expect(byWeight?.nextRemaining).toBe(700)

    const byLength = estimateAfterUse(sampleSpool, 'length', 1000)
    expect(byLength).not.toBeNull()
    expect(byLength!.deltaGrams).toBeCloseTo(2.98, 1)
    expect(byLength!.nextRemaining).toBeCloseTo(747.02, 1)

    const measured = estimateAfterMeasure(sampleSpool, 810)
    expect('error' in measured).toBe(false)
    if (!('error' in measured)) {
      expect(measured.tare).toBe(210)
      expect(measured.nextRemaining).toBe(600)
    }

    const { initial_weight: _iw, ...spoolWithoutInitial } = sampleSpool
    const { weight: _w, ...filamentWithoutWeight } = sampleFilament
    const noInitial: SpoolItem = {
      ...spoolWithoutInitial,
      filament: filamentWithoutWeight,
    }
    const measureErr = estimateAfterMeasure(noInitial, 500)
    expect('error' in measureErr).toBe(true)
  })
})

describe('spool-library query builders and form validators', () => {
  test('builds clean query objects for spools, filaments, and vendors', () => {
    expect(buildSpoolQuery(EMPTY_SPOOL_FILTERS)).toEqual({ sort: 'id:desc' })
    expect(
      buildSpoolQuery({
        q: 'Prusament',
        material: 'PLA',
        vendorId: '2',
        location: 'Estante A',
        allowArchived: true,
        sort: 'remaining_weight:asc',
      }),
    ).toEqual({
      q: 'Prusament',
      filament_material: 'PLA',
      vendor_id: '2',
      location: 'Estante A',
      allow_archived: true,
      sort: 'remaining_weight:asc',
    })

    expect(
      buildFilamentQuery({
        ...EMPTY_FILAMENT_FILTERS,
        q: 'Galaxy',
        material: 'PLA',
        vendorId: '2',
      }),
    ).toEqual({
      q: 'Galaxy',
      material: 'PLA',
      vendor_id: '2',
      sort: 'id:desc',
    })

    expect(buildVendorQuery({ ...EMPTY_VENDOR_FILTERS, q: 'Prusa' })).toEqual({
      q: 'Prusa',
      sort: 'name:asc',
    })
  })

  test('validates vendor, filament, and spool form inputs', () => {
    const badVendor = validateVendorForm({
      name: '   ',
      emptySpoolWeight: '-5',
      externalId: '',
      comment: '',
    })
    expect(badVendor.ok).toBe(false)
    if (!badVendor.ok) {
      expect(badVendor.errors.name).toBeTruthy()
      expect(badVendor.errors.emptySpoolWeight).toBeTruthy()
    }

    const goodVendor = validateVendorForm({
      name: '3DLab',
      emptySpoolWeight: '195,5',
      externalId: '3dlab-br',
      comment: 'Fornecedor local',
    })
    expect(goodVendor).toEqual({
      ok: true,
      payload: {
        name: '3DLab',
        empty_spool_weight: 195.5,
        external_id: '3dlab-br',
        comment: 'Fornecedor local',
      },
    })

    const badFilament = validateFilamentForm({
      name: 'Teste',
      vendorId: '',
      material: 'PLA',
      density: '0',
      diameter: '1.75',
      weight: '',
      spoolWeight: '',
      price: '',
      articleNumber: '',
      extruderTemp: '210.5',
      bedTemp: '',
      colorMode: 'multi',
      colorHex: '',
      multiColorHexes: 'FF0000',
      multiColorDirection: 'coaxial',
      comment: '',
    })
    expect(badFilament.ok).toBe(false)
    if (!badFilament.ok) {
      expect(badFilament.errors.density).toBeTruthy()
      expect(badFilament.errors.extruderTemp).toBeTruthy()
      expect(badFilament.errors.multiColorHexes).toBeTruthy()
    }

    const goodSpool = validateSpoolForm({
      filamentId: '10',
      initialWeight: '1000',
      spoolWeight: '200',
      weightMode: 'remaining',
      remainingWeight: '850',
      usedWeight: '999',
      price: '120,50',
      location: 'Drybox 1',
      lotNr: 'L1',
      comment: 'Aberto hoje',
      archived: false,
    })
    expect(goodSpool).toEqual({
      ok: true,
      payload: {
        filament_id: 10,
        initial_weight: 1000,
        spool_weight: 200,
        remaining_weight: 850,
        price: 120.5,
        location: 'Drybox 1',
        lot_nr: 'L1',
        comment: 'Aberto hoje',
        archived: false,
      },
    })
  })

  test('validates Spoolman API, JSON, and CSV import forms', () => {
    const apiOk = validateImportForm({
      format: 'spoolman-api',
      origin: 'http://spoolman.lan:7912/api/v1/spool',
      bearerToken: 'secret-token',
      jsonText: '',
      csvEntity: 'spools',
      csvText: '',
      source: 'spoolman-oficina',
      dryRun: true,
      onCollision: 'adopt',
      onConflict: 'keep-local',
    })
    expect(apiOk).toEqual({
      ok: true,
      payload: {
        format: 'spoolman-api',
        origin: 'http://spoolman.lan:7912',
        bearerToken: 'secret-token',
        source: 'spoolman-oficina',
        dryRun: true,
        onCollision: 'adopt',
        onConflict: 'keep-local',
      },
    })

    const badJson = validateImportForm({
      format: 'json',
      origin: '',
      bearerToken: '',
      jsonText: '[1, 2, 3]',
      csvEntity: 'spools',
      csvText: '',
      source: '',
      dryRun: false,
      onCollision: 'adopt',
      onConflict: 'keep-local',
    })
    expect(badJson.ok).toBe(false)

    const csvOk = validateImportForm({
      format: 'csv',
      origin: '',
      bearerToken: '',
      jsonText: '',
      csvEntity: 'vendors',
      csvText: 'id,name\n1,Prusament\n',
      source: '',
      dryRun: false,
      onCollision: 'create',
      onConflict: 'overwrite',
    })
    expect(csvOk).toEqual({
      ok: true,
      payload: {
        format: 'csv',
        entity: 'vendors',
        csv: 'id,name\n1,Prusament\n',
        dryRun: false,
        onCollision: 'create',
        onConflict: 'overwrite',
      },
    })
  })

  test('extracts API error messages, validation problems, and formats report rows', () => {
    const parsed = extractApiError(
      {
        statusCode: 422,
        data: {
          message: 'Os dados importados são inválidos.',
          data: {
            problems: [{ path: 'spools[0].filament_id', problem: 'required' }],
          },
        },
      },
      'Erro genérico',
    )
    expect(parsed.status).toBe(422)
    expect(parsed.message).toBe('Os dados importados são inválidos.')
    expect(parsed.problems).toEqual([
      { path: 'spools[0].filament_id', problem: 'required' },
    ])

    const counts = {
      created: 2,
      updated: 1,
      unchanged: 0,
      adopted: 1,
      conflicts: 0,
    }
    const report: ImportReport = {
      runId: '12345678-aaaa-4bbb-8ccc-1234567890ab',
      dryRun: true,
      sourceKey: 'json-default',
      vendors: counts,
      filaments: counts,
      spools: counts,
      fields: counts,
      settings: counts,
      truncated: 0,
      skippedSettings: [],
      conflicts: [],
    }
    expect(reportRows(report).map((r) => r.label)).toEqual([
      'Fornecedores',
      'Filamentos',
      'Bobinas',
      'Campos extras',
      'Configurações',
    ])
  })
})
