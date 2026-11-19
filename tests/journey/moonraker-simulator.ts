import {
  startHttpMock,
  startMoonrakerMock,
  type MoonrakerMockInstance,
  type MoonrakerMockOptions,
  type MoonrakerModel,
} from '../../packages/sim-tools/src/mocks/index.ts'

export {
  startMoonrakerMock,
  type MoonrakerMockInstance,
  type MoonrakerMockOptions,
  type MoonrakerModel,
}

/** What the simulated printer reports; journeys change it with `update`. */
export type PrinterModel = Readonly<{
  state: 'standby' | 'printing' | 'paused' | 'complete' | 'cancelled' | 'error'
  progress: number
  filename: string
  extruder: number
  bed: number
  fan: number
}>

export type MoonrakerSimulator = Readonly<{
  /** `http://127.0.0.1:<port>`: Moonraker (`/server/info`, `/websocket`). */
  origin: string
  /** `http://127.0.0.1:<port>`: an empty Spoolman inventory. */
  spoolmanOrigin: string
  model(): PrinterModel
  /** Applies a change and pushes it to every subscriber as Moonraker would. */
  update(patch: Partial<PrinterModel>): void
  /** JSON-RPC calls received, by method. */
  calls(): Readonly<Record<string, number>>
  control: MoonrakerMockInstance['control']
  close(): Promise<void>
}>

function projectModel(model: MoonrakerModel): PrinterModel {
  return {
    state: model.state,
    progress: model.progress,
    filename: model.filename,
    extruder: model.extruder,
    bed: model.bed,
    fan: model.fan,
  }
}

/**
 * Harness-backed Moonraker + empty Spoolman simulator on loopback.
 */
export async function startMoonrakerSimulator(
  initial: Partial<PrinterModel> = {},
  options: Omit<MoonrakerMockOptions, 'initial'> = {},
): Promise<MoonrakerSimulator> {
  const moonraker = await startMoonrakerMock({
    ...options,
    initial: {
      state: 'printing',
      progress: 0.25,
      filename: 'journey.gcode',
      extruder: 210,
      bed: 60,
      fan: 0.5,
      ...initial,
    },
  })

  let spoolman: Awaited<ReturnType<typeof startHttpMock>>
  try {
    spoolman = await startHttpMock({
      handler: (request, response) => {
        if (
          request.method !== 'GET' ||
          !request.url?.startsWith('/api/v1/spool')
        ) {
          response.writeHead(404).end()
          return
        }
        response.setHeader('content-type', 'application/json')
        response.end('[]')
      },
    })
  } catch (error) {
    await moonraker.close()
    throw error
  }

  return Object.freeze({
    origin: moonraker.origin,
    spoolmanOrigin: spoolman.origin,
    model: () => projectModel(moonraker.control.model()),
    update(patch: Partial<PrinterModel>) {
      moonraker.control.update(patch)
    },
    calls: () => moonraker.calls(),
    control: moonraker.control,
    async close() {
      await Promise.all([moonraker.close(), spoolman.close()])
    },
  })
}
