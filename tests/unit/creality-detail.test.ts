import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import WebSocket from 'ws'
import { expect, test } from 'vitest'
import { controlAreaKeys } from '../../apps/farm/app/utils/compatibility/control-areas.ts'
import { crealityCatalog } from '../../apps/farm/app/utils/compatibility/creality.ts'
import { buildCrealityCommand } from '../../packages/connector/src/creality/commands.ts'
import {
  buildCrealityConsoleLine,
  createCrealityDetailStream,
  crealityDetailUpdate,
  CrealityDetailRefused,
} from '../../packages/connector/src/creality/printer-detail.ts'
import { createPrinterDetailSession } from '../../packages/connector/src/runtime/printer-detail-session.ts'
import { decodePrinterDetailFrame } from '../../packages/farm-protocol/src/printer-detail.ts'
import { createCrealitySimulator } from '../../packages/sim-tools/src/creality-simulator.ts'

type Frame = ReturnType<typeof decodePrinterDetailFrame>

async function watch(
  frame: object,
  options: Parameters<typeof createCrealityDetailStream>[1] = {},
) {
  const printerKey = 'stock'
  const mock = await createCrealitySimulator(frame)
  const source = createCrealityDetailStream(
    { printerKey, host: '127.0.0.1', port: mock.port },
    options,
  )
  const frames: Frame[] = []
  const session = createPrinterDetailSession(
    () => source,
    (key) => key === printerKey,
    (wires) => frames.push(...wires.map(decodePrinterDetailFrame)),
  )
  session.receive(
    JSON.stringify({ v: 1, t: 'detail.subscribe', printerKey: 'other' }),
  )
  session.receive(JSON.stringify({ v: 1, t: 'detail.subscribe', printerKey }))
  return {
    mock,
    frames,
    session,
    printerKey,
    async close() {
      session.close()
      await mock.close()
    },
  }
}

test('reports temperatures and print status', async () => {
  const run = await watch({
    state: 1,
    nozzleTemp: 207,
    nozzleTemp2: 210,
    bedTemp: 59,
    bedTemp2: 60,
    printProgress: 42,
    printFileName: 'part.gcode',
    printJobTime: 12,
    layer: 3,
    TotalLayer: 9,
  })
  try {
    await expect
      .poll(() => run.frames[0])
      .toMatchObject({
        t: 'detail.update',
        printerKey: run.printerKey,
        vendor: 'creality',
        capabilities: ['heaters', 'job'],
        detail: {
          heaters: [
            { name: 'extruder', temperature: 207, target: 210 },
            { name: 'bed', temperature: 59, target: 60 },
          ],
          print: {
            state: 'printing',
            file: 'part.gcode',
            elapsedSeconds: 12,
            progress: 0.42,
            currentLayer: 3,
            totalLayers: 9,
          },
        },
      })
    // Subscribing never writes to the printer, and the other key is refused.
    expect(run.mock.received).toEqual([])
    expect(run.frames.every(({ printerKey }) => printerKey === 'stock')).toBe(
      true,
    )
  } finally {
    await run.close()
  }
})

test('refuses every query the protocol does not document', async () => {
  const run = await watch({ state: 0, nozzleTemp: 30 })
  try {
    await expect.poll(() => run.frames.length).toBeGreaterThan(0)
    const kinds = ['files', 'history', 'job-queue', 'timelapse'] as const
    for (const kind of kinds)
      run.session.receive(
        JSON.stringify({
          v: 1,
          t: 'query.request',
          printerKey: run.printerKey,
          kind,
          requestId: `${kind}-1`,
        }),
      )
    await expect
      .poll(() => run.frames.filter(({ t }) => t === 'query.response'))
      .toHaveLength(kinds.length)
    for (const reply of run.frames.filter(({ t }) => t === 'query.response'))
      expect(reply).toMatchObject({ error: 'unsupported' })
    expect(run.mock.received).toEqual([])
  } finally {
    await run.close()
  }
})

test('reports fans and the light', async () => {
  const run = await watch({
    state: 0,
    nozzleTemp: 30,
    modelFanPct: 50,
    auxiliaryFanPct: 0,
    caseFanPct: 100,
    lightSw: 1,
  })
  try {
    await expect
      .poll(() => run.frames[0])
      .toMatchObject({
        capabilities: ['heaters', 'fans', 'lights', 'job'],
        detail: {
          fans: [
            { name: 'part', speed: 0.5 },
            { name: 'aux', speed: 0 },
            { name: 'chamber', speed: 1 },
          ],
          lights: [{ name: 'chamber', white: 1 }],
        },
      })
    run.mock.control.setFrame({ lightSw: 0 })
    await expect
      .poll(
        () =>
          (
            run.frames.at(-1) as Frame & {
              detail: { lights: [{ white: number }] }
            }
          ).detail.lights[0].white,
      )
      .toBe(0)
  } finally {
    await run.close()
  }
})

function send(mock: { port: number }, payloads: object[]) {
  return new Promise<void>((resolveDone, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${mock.port}`)
    socket.once('error', reject)
    socket.once('open', () => {
      for (const payload of payloads) socket.send(JSON.stringify(payload))
      setTimeout(() => {
        socket.close()
        resolveDone()
      }, 50)
    })
  })
}

test('sends every supported set frame to the simulator', async () => {
  const mock = await createCrealitySimulator({ state: 0 })
  try {
    await send(mock, [
      buildCrealityCommand('set_temperature', {
        heater: 'extruder',
        target_c: 210,
      }),
      buildCrealityCommand('set_temperature', { heater: 'bed', target_c: 60 }),
      buildCrealityCommand('set_fan', { fan: 'part', percent: 100 }),
      buildCrealityCommand('set_fan', { fan: 'aux', on: true }),
      buildCrealityCommand('set_fan', { fan: 'chamber', percent: 100 }),
      buildCrealityCommand('set_light', { on: true }),
      buildCrealityCommand('home', { axes: ['x', 'y', 'z'] }),
    ])
    await expect.poll(() => mock.requests.length).toBe(7)
    expect(mock.requests.map(({ params }) => params)).toEqual([
      { nozzleTempControl: 210 },
      { bedTempControl: { num: 0, val: 60 } },
      { fan: 1 },
      { fanAuxiliary: 1 },
      { fanCase: 1 },
      { lightSw: 1 },
      { autohome: 'X Y Z' },
    ])
    expect(mock.state).toMatchObject({
      nozzleTemp2: 210,
      bedTemp2: 60,
      modelFanPct: 100,
      auxiliaryFanPct: 100,
      caseFanPct: 100,
      lightSw: 1,
      autohome: 'X Y Z',
    })
  } finally {
    await mock.close()
  }
})

test('refuses unsafe or undocumented commands before anything is sent', () => {
  const refused: Array<[string, Record<string, unknown>]> = [
    ['set_temperature', { heater: 'extruder', target_c: 301 }],
    ['set_temperature', { heater: 'bed', target_c: 121 }],
    ['set_temperature', { heater: 'extruder', target_c: -1 }],
    ['set_temperature', { heater: 'extruder', target_c: 210.5 }],
    ['set_fan', { fan: 'unknown', percent: 100 }],
    ['set_fan', { fan: 'part', percent: 101 }],
    ['set_light', { on: 1 }],
    ['home', { axes: ['x', 'x'] }],
    ['home', { axes: [] }],
    ['jog', { axis: 'x', distance_mm: 1, feed: 600 }],
    ['extrude', { tool: 0, length_mm: 5, feed: 300 }],
    ['run_macro', { name: 'M112' }],
    ['emergency_stop', {}],
    ['delete_file', { file: 'part.gcode' }],
    ['firmware_restart', {}],
  ]
  for (const [action, args] of refused)
    expect(() => buildCrealityCommand(action, args), action).toThrow()
})

test('console lines follow the E18.1 rules', () => {
  // Off by default: nothing is built, whatever the line or state.
  expect(() => buildCrealityConsoleLine('M105', 'idle')).toThrow(
    CrealityDetailRefused,
  )
  expect(() => buildCrealityConsoleLine('M105', 'idle', false)).toThrow(
    expect.objectContaining({ refusal: 'disabled' }),
  )
  expect(buildCrealityConsoleLine(' G28 ', 'idle', true)).toEqual({
    method: 'set',
    params: { gcodeCmd: 'G28' },
  })
  for (const state of ['printing', 'paused'])
    for (const line of ['M105', 'M220 S100', 'M221 S95'])
      expect(buildCrealityConsoleLine(line, state, true).params.gcodeCmd).toBe(
        line,
      )
  for (const line of ['G28', 'M112', 'M104 S300', 'M220 S9', 'M221 S151'])
    expect(() => buildCrealityConsoleLine(line, 'printing', true)).toThrow(
      expect.objectContaining({ refusal: 'state' }),
    )
  for (const state of ['error', undefined, 'unknown'])
    expect(() => buildCrealityConsoleLine('M105', state, true)).toThrow(
      expect.objectContaining({ refusal: 'state' }),
    )
  for (const line of ['', '   ', 'G1 X1\nG1 X2', 'G28 é', 'M'.repeat(257), 5])
    expect(() => buildCrealityConsoleLine(line, 'idle', true)).toThrow(
      expect.objectContaining({ refusal: 'invalid-command' }),
    )
  expect(
    buildCrealityConsoleLine('M'.repeat(256), 'idle', true).params.gcodeCmd,
  ).toHaveLength(256)
})

test('advertises the configured camera', async () => {
  const run = await watch(
    { state: 0, nozzleTemp: 30 },
    { cameraId: 'camera-stock', consoleEnabled: true },
  )
  try {
    await expect
      .poll(() => run.frames[0])
      .toMatchObject({
        capabilities: ['heaters', 'job', 'webcams', 'console'],
        detail: { webcams: [{ uid: 'camera-stock', enabled: true }] },
      })
  } finally {
    await run.close()
  }
  const plain = crealityDetailUpdate('stock', 0, { nozzleTemp: 30 })
  expect(plain?.capabilities).toEqual(['heaters'])
  expect(plain?.detail.webcams).toBeUndefined()
  expect(crealityDetailUpdate('stock', 1, {})).toBeUndefined()
})

test('catalog cites its sources and keeps undocumented areas unavailable', () => {
  const doc = resolve(__dirname, '../../docs/protocols/creality-detail.md')
  expect(existsSync(doc)).toBe(true)
  const text = readFileSync(doc, 'utf8')
  const unsupported = [
    'extrusion',
    'macros',
    'excludeObject',
    'jobQueue',
    'fileManager',
    'bedMesh',
    'config',
    'services',
    'history',
    'timelapse',
    'power',
    'updates',
  ]
  for (const area of unsupported) expect(text).toContain(area)
  for (const product of crealityCatalog) {
    expect(
      product.sources.some((src) => src.endsWith('creality-detail.md')),
    ).toBe(true)
    for (const area of unsupported)
      expect(
        product.controlAreas[area as keyof typeof product.controlAreas],
      ).toBe('unsupported')
    for (const area of [
      'temperatures',
      'fans',
      'leds',
      'motion',
      'printStatus',
      'console',
      'webcams',
    ] as const) {
      expect(product.controlAreas[area]).toBe('simulated')
      expect(product.controlAreaEvidence?.[area]?.file).toBe(
        'tests/unit/creality-detail.test.ts',
      )
    }
    expect(Object.keys(product.controlAreas).sort()).toEqual(
      [...controlAreaKeys].sort(),
    )
  }
})
