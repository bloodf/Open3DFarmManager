import type {
  ControlAreaCapabilities,
  ControlAreaEvidenceMap,
} from './control-areas.ts'

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

export const kobraXControlAreaEvidence = {
  temperatures: {
    file: 'tests/node/pause-dispatch-driver-integration.test.ts',
    test: 'native Kobra X accepts signed controls through the pinned runtime driver',
  },
  fans: {
    file: 'tests/node/pause-dispatch-driver-integration.test.ts',
    test: 'native Kobra X accepts signed controls through the pinned runtime driver',
  },
  leds: {
    file: 'tests/node/pause-dispatch-driver-integration.test.ts',
    test: 'native Kobra X accepts signed controls through the pinned runtime driver',
  },
} as const satisfies ControlAreaEvidenceMap
export const kobraXControlAreas: ControlAreaCapabilities = {
  ...anycubicControlAreas,
  temperatures: 'simulated',
  fans: 'simulated',
  leds: 'simulated',
  webcams: 'unsupported',
}

export const kobraXDetailSource =
  'https://github.com/bloodf/Open3DFarmManager/blob/main/docs/protocols/kobra-x-detail.md'
