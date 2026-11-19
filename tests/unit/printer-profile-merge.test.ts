import { describe, expect, test } from 'vitest'
import {
  EMPTY_OVERRIDE,
  MACHINE_PROFILE_FIELDS,
  detectedProfile,
  machineProfileEditSchema,
  machineProfileView,
  mergeEffectiveProfile,
  normalizeEdit,
  type MachineProfileOverride,
  type MachineProfileValues,
} from '../../apps/farm/server/utils/machine-profile.ts'

const detected: MachineProfileValues = {
  model: 'Detectada X1',
  nozzleDiameterMm: 0.4,
  bedSizeXMm: 220,
  bedSizeYMm: 220,
  bedSizeZMm: 250,
  maxHotendTemperatureCelsius: 260,
  maxBedTemperatureCelsius: 100,
  kinematics: 'cartesian',
}
const override = (patch: Partial<MachineProfileOverride>) => ({
  ...EMPTY_OVERRIDE,
  compatibleModels: [],
  ...patch,
})
const validEdit = {
  ...EMPTY_OVERRIDE,
  compatibleModels: ['Modelo A'],
}

describe('effective profile merge', () => {
  test('uses the detected value for every field without an override', () => {
    const merged = mergeEffectiveProfile(detected, override({}))
    expect(merged.values).toEqual(detected)
    for (const field of MACHINE_PROFILE_FIELDS)
      expect(merged.sources[field]).toBe('detected')
  })

  test('an override wins over the detected value only for its own field', () => {
    const merged = mergeEffectiveProfile(
      detected,
      override({ model: 'Apelido do dono', nozzleDiameterMm: 0.6 }),
    )
    expect(merged.values).toEqual({
      ...detected,
      model: 'Apelido do dono',
      nozzleDiameterMm: 0.6,
    })
    expect(merged.sources.model).toBe('override')
    expect(merged.sources.nozzleDiameterMm).toBe('override')
    expect(merged.sources.bedSizeXMm).toBe('detected')
  })

  test('a cleared override (null) falls back to the detected value', () => {
    const merged = mergeEffectiveProfile(
      detected,
      override({ bedSizeZMm: null }),
    )
    expect(merged.values.bedSizeZMm).toBe(250)
    expect(merged.sources.bedSizeZMm).toBe('detected')
  })

  test('keeps a falsy but valid override instead of treating it as missing', () => {
    const merged = mergeEffectiveProfile(detected, override({ model: 'a' }))
    expect(merged.values.model).toBe('a')
  })

  test('fields neither detected nor overridden are unknown', () => {
    const merged = mergeEffectiveProfile(
      { ...detected, kinematics: null },
      override({}),
    )
    expect(merged.values.kinematics).toBeNull()
    expect(merged.sources.kinematics).toBe('unknown')
  })

  test('without a detected state or override nothing is known', () => {
    const merged = mergeEffectiveProfile(null, null)
    for (const field of MACHINE_PROFILE_FIELDS) {
      expect(merged.values[field]).toBeNull()
      expect(merged.sources[field]).toBe('unknown')
    }
    expect(merged.compatibleModels).toEqual([])
    expect(merged.notes).toBeNull()
  })

  test('owner metadata is carried through and copied, never shared', () => {
    const owner = override({ compatibleModels: ['A', 'B'], notes: 'Bico novo' })
    const merged = mergeEffectiveProfile(detected, owner)
    expect(merged.compatibleModels).toEqual(['A', 'B'])
    expect(merged.notes).toBe('Bico novo')
    merged.compatibleModels.push('C')
    expect(owner.compatibleModels).toEqual(['A', 'B'])
  })

  test('does not mutate its inputs', () => {
    const frozenDetected = Object.freeze({ ...detected })
    const frozenOwner = Object.freeze(override({ model: 'x' }))
    expect(() =>
      mergeEffectiveProfile(frozenDetected, frozenOwner),
    ).not.toThrow()
    expect(EMPTY_OVERRIDE.compatibleModels).toEqual([])
  })
})

describe('detected profile from a stored state', () => {
  const base = {
    printerKey: 'moonraker-a',
    state: 'idle',
    progress: 0,
    observedAt: 1,
  }

  test('reads the machine profile of a valid snapshot', () => {
    expect(
      detectedProfile({
        ...base,
        machine: {
          model: 'Voron 2.4',
          nozzleDiameterMm: { '1': 0.6, '0': 0.4 },
          bedSizeMm: { x: 350, y: 350, z: 330 },
          maxHotendTemperatureCelsius: { '0': 300, '1': 280 },
          maxBedTemperatureCelsius: 120,
          kinematics: 'corexy',
        },
      }),
    ).toEqual({
      model: 'Voron 2.4',
      nozzleDiameterMm: 0.4,
      bedSizeXMm: 350,
      bedSizeYMm: 350,
      bedSizeZMm: 330,
      maxHotendTemperatureCelsius: 300,
      maxBedTemperatureCelsius: 120,
      kinematics: 'corexy',
    })
  })

  test('falls back to the observed identity model and the hottest tool', () => {
    const profile = detectedProfile({
      ...base,
      identity: { model: 'Identidade Y' },
      machine: { maxHotendTemperatureCelsius: { '2': 250, '3': 280 } },
    })
    expect(profile.model).toBe('Identidade Y')
    expect(profile.maxHotendTemperatureCelsius).toBe(280)
    expect(profile.nozzleDiameterMm).toBeNull()
  })

  test.each([null, undefined, 'x', 42, {}, { ...base, state: 'bogus' }])(
    'detects nothing from an invalid snapshot (%j)',
    (state) => {
      expect(Object.values(detectedProfile(state))).toEqual(
        Array(MACHINE_PROFILE_FIELDS.length).fill(null),
      )
    },
  )
})

describe('owner edit validation', () => {
  test('accepts a full edit and trims text', () => {
    const parsed = machineProfileEditSchema.parse({
      ...validEdit,
      model: '  Ender 3  ',
      notes: ' ok ',
    })
    expect(parsed.model).toBe('Ender 3')
    expect(parsed.notes).toBe('ok')
  })

  test.each([
    ['unknown field', { ...validEdit, extra: 1 }],
    ['missing field', { ...validEdit, notes: undefined }],
    ['blank model', { ...validEdit, model: '   ' }],
    ['control character', { ...validEdit, kinematics: 'a\u0000b' }],
    ['non-positive nozzle', { ...validEdit, nozzleDiameterMm: 0 }],
    ['huge bed', { ...validEdit, bedSizeXMm: 5001 }],
    ['infinite bed', { ...validEdit, bedSizeYMm: Infinity }],
    ['string number', { ...validEdit, bedSizeZMm: '200' }],
    [
      'too many models',
      { ...validEdit, compatibleModels: Array(17).fill('a') },
    ],
    ['long note', { ...validEdit, notes: 'a'.repeat(1001) }],
  ])('rejects %s', (_name, body) => {
    expect(machineProfileEditSchema.safeParse(body).success).toBe(false)
  })

  test('normalization removes duplicate compatible models in order', () => {
    const parsed = machineProfileEditSchema.parse({
      ...validEdit,
      compatibleModels: ['B', 'A', 'B'],
    })
    expect(normalizeEdit(parsed).compatibleModels).toEqual(['B', 'A'])
  })
})

describe('profile view', () => {
  test('is the same shape with and without a stored override', () => {
    const none = machineProfileView('a', detected, null)
    expect(none).toMatchObject({
      assignmentId: 'a',
      detected,
      override: EMPTY_OVERRIDE,
      updatedBy: null,
      updatedAt: null,
    })
    expect(none.effective.values).toEqual(detected)
    const stored = machineProfileView('a', detected, {
      ...override({ model: 'Dono' }),
      updatedBy: 'account',
      updatedAt: 5,
    })
    expect(stored.effective.values.model).toBe('Dono')
    expect(stored).toMatchObject({ updatedBy: 'account', updatedAt: 5 })
  })
})
