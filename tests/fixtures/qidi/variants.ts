// spec-derived, not captured. Synthetic values on object names taken from the
// pinned Qidi sources listed in docs/fullfarmmanager/evidence/qidi.md
// (QIDITECH vendor configs, screen clients and QIDIStudio).
import type { QidiModel } from '../../../packages/connector/src/qidi/profiles.ts'

// Query strings and expectations are written out here, independently of the
// adapter's profile table.
const BASE =
  '/printer/objects/query?webhooks&print_stats&virtual_sdcard&extruder&heater_bed'
const Q_QUERY = `${BASE}&fan_generic%20cooling_fan&fan_generic%20auxiliary_cooling_fan&fan_generic%20chamber_circulation_fan&heater_generic%20chamber`

type Variant = Readonly<{
  model: QidiModel
  /** Model-specific objects, including decoys the model must not read. */
  objects: Record<string, Record<string, unknown>>
  query: string
  fans: { part?: number; aux?: number; chamber?: number }
  chamber?: { temperature: number; target: number }
  materials?: { slot: string; materialType?: string; colorHex?: string }[]
}>

const qObjects = (part: number, aux: number, circulation: number) => ({
  'fan_generic cooling_fan': { speed: part / 100 },
  'fan_generic auxiliary_cooling_fan': { speed: aux / 100 },
  'fan_generic chamber_circulation_fan': { speed: circulation / 100 },
  'heater_generic chamber': { temperature: 41.5, target: 45 },
  // Decoys: neither name is in a Q-series vendor configuration.
  fan: { speed: 0.99 },
  'heater_generic hot': { temperature: 99, target: 99 },
})
const qSeries = (
  model: QidiModel,
  part: number,
  aux: number,
  circulation: number,
): Variant => ({
  model,
  objects: {
    ...qObjects(part, aux, circulation),
    // Decoy: no Box status object is declared for this model.
    multi_color_controller: {
      box_count: 1,
      box0_box_inserted_0: 1,
      box0_filament_info_0_filament_type: 'DECOY',
    },
  },
  query: Q_QUERY,
  fans: { part, aux, chamber: circulation },
  chamber: { temperature: 41.5, target: 45 },
})

// Decoys: the Max3 and Smart3 screen clients subscribe these without naming
// their roles, so the adapter must not report them.
const unnamedRoles = (model: QidiModel, part: number): Variant => ({
  model,
  objects: {
    fan: { speed: part / 100 },
    'fan_generic cooling_fan': { speed: 0.99 },
    'output_pin fan0': { value: 0.91 },
    'output_pin fan2': { value: 0.92 },
    'output_pin fan3': { value: 0.93 },
    'heater_generic hot': { temperature: 99, target: 99 },
  },
  query: `${BASE}&fan`,
  fans: { part },
})

export const qidiVariants: readonly Variant[] = [
  qSeries('Q1 Pro', 51, 22, 33),
  qSeries('Plus4', 52, 23, 34),
  qSeries('Q2', 53, 24, 35),
  {
    model: 'Max4',
    objects: {
      ...qObjects(54, 25, 36),
      'fan_generic auxiliary_cooling_fan2': { speed: 0.25 },
      multi_color_controller: {
        box_count: 1,
        box: {
          box0_box_inserted_0: 1,
          box0_filament_info_0_filament_type: 'PETG',
          box0_filament_info_0_color_rgb_str: ['#2850ff'],
          box0_box_inserted_1: 0,
          box0_filament_info_1_filament_type: 'EMPTY-SLOT',
          box0_box_inserted_3: 1,
          // Beyond box_count: stale data of an unreported Box.
          box1_box_inserted_0: 1,
          box1_filament_info_0_filament_type: 'STALE-BOX',
        },
      },
    },
    query: `${BASE}&fan_generic%20cooling_fan&fan_generic%20auxiliary_cooling_fan&fan_generic%20auxiliary_cooling_fan2&fan_generic%20chamber_circulation_fan&heater_generic%20chamber&multi_color_controller`,
    fans: { part: 54, aux: 25, chamber: 36 },
    chamber: { temperature: 41.5, target: 45 },
    materials: [
      {
        slot: 'QIDI Box 1, slot 1',
        materialType: 'PETG',
        colorHex: '2850FFFF',
      },
      { slot: 'QIDI Box 1, slot 4' },
    ],
  },
  unnamedRoles('X-Max 3', 57),
  {
    model: 'X-Plus 3',
    objects: {
      'output_pin fan0': { value: 0.61 },
      'output_pin fan2': { value: 0.27 },
      'output_pin fan3': { value: 0.38 },
      'heater_generic hot': { temperature: 38.5, target: 40 },
      // Decoys: the names this client says it replaced.
      fan: { speed: 0.99 },
      'fan_generic cooling_fan': { speed: 0.99 },
      'heater_generic chamber': { temperature: 99, target: 99 },
    },
    query: `${BASE}&output_pin%20fan0&output_pin%20fan2&output_pin%20fan3&heater_generic%20hot`,
    fans: { part: 61, aux: 27, chamber: 38 },
    chamber: { temperature: 38.5, target: 40 },
  },
  unnamedRoles('X-Smart 3', 59),
]

export function qidiVariant(model: string) {
  const variant = qidiVariants.find((entry) => entry.model === model)
  if (!variant) throw new Error(`No Qidi fixture for ${model}`)
  return variant
}
