import type { ControlAreaCapabilities } from './control-areas.ts'

export const anycubicControlAreas = {
  temperatures: 'documented',
  motion: 'unsupported',
  extrusion: 'unsupported',
  fans: 'documented',
  leds: 'documented',
  macros: 'unsupported',
  console: 'unsupported',
  printStatus: 'documented',
  excludeObject: 'unsupported',
  jobQueue: 'unsupported',
  fileManager: 'documented',
  webcams: 'documented',
  bedMesh: 'unsupported',
  config: 'unsupported',
  services: 'unsupported',
  history: 'unsupported',
  timelapse: 'unsupported',
  power: 'unsupported',
  updates: 'unsupported',
} as const satisfies ControlAreaCapabilities

export const kobraXControlAreas: ControlAreaCapabilities = {
  ...anycubicControlAreas,
  webcams: 'unsupported',
}

export const kobraXDetailSource =
  'https://github.com/bloodf/Open3DFarmManager/blob/main/docs/protocols/kobra-x-detail.md'
