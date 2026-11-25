import fixture from './detail.json' with { type: 'json' }

// Model identifiers and two file-list schemas come from protocol observations.
// https://github.com/Parallel-7/flashforge-api-docs/wiki/Printer-PIDs
// https://github.com/Parallel-7/flashforge-api-docs/wiki/HTTP-REST-API
const { cameraStreamUrl, internalFanStatus, externalFanStatus, ...common } =
  fixture.detail
const ready = {
  ...common,
  status: 'ready',
  printFileName: '',
  printProgress: 0,
}

export const flashforgeModels = [
  {
    name: 'Adventurer 5M',
    pid: 35,
    detail: { ...ready, pid: 35 },
    firmware: ['3.2.7', '5.1.8'],
    files: ['base.gcode'],
  },
  {
    name: 'Adventurer 5M Pro',
    pid: 36,
    detail: { ...ready, cameraStreamUrl, internalFanStatus, externalFanStatus },
    firmware: ['3.2.7', '5.1.8'],
    files: ['pro.gcode'],
  },
  {
    name: 'AD5X',
    pid: 38,
    detail: {
      ...ready,
      pid: '0026',
      cameraStreamUrl,
      hasMatlStation: true,
      matlStationInfo: {
        slotInfos: [
          { slotId: 0, hasFilament: false },
          {
            slotId: 3,
            hasFilament: true,
            materialName: 'PETG',
            materialColor: '#113355',
          },
        ],
      },
    },
    firmware: ['1.1.7', '1.2.1', '3.1.0'],
    files: ['multi.3mf'],
  },
]

export const unsupportedFlashforgeModels = [
  { name: 'Guider 2', pid: 4 },
  { name: 'Adventurer 3', pid: 8 },
  { name: 'Finder 3', pid: 23 },
  { name: 'Adventurer 4 Pro', pid: 30 },
  { name: 'Guider 4', pid: 37 },
  { name: 'Guider 4 Pro', pid: 39 },
  { name: 'Creator 5', pid: 40 },
  { name: 'Creator 5 Pro', pid: 41 },
]
