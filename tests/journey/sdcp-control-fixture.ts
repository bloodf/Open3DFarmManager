// Spec-derived SDCP resin simulator for the control journey (frames:
// cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0 @ f977215, see
// packages/sim-tools/src/sdcp-simulator.ts) with a loopback RTSP camera and
// the repository's own ingest helper. No printer is contacted.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startCameraMock } from '../../packages/sim-tools/src/camera-mock.ts'
import { startSdcpSimulator } from '../../packages/sim-tools/src/sdcp-simulator.ts'

const HOST = '127.0.0.1'
export const SDCP_JOURNEY_BOARD = 'journey01'
export const SDCP_JOURNEY_MODEL = 'Saturn 4 Ultra'
export const SDCP_JOURNEY_FIRMWARE = 'V1.0.0'

/** Builds the ingest helper from this checkout (needs the local Go). */
async function buildHelper(directory: string) {
  const path = join(await realpath(directory), 'rtsp-ingest')
  execFileSync(
    process.env.OPENFARM_GO ?? 'go',
    ['build', '-mod=readonly', '-o', path, './cmd/rtsp-ingest'],
    {
      cwd: fileURLToPath(new URL('../../tools/rtsp-ingest', import.meta.url)),
      timeout: 240_000,
      stdio: 'pipe',
    },
  )
  const sha256 = createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
  return { path, sha256 }
}

export async function startSdcpControlFixture(directory: string) {
  const helper = await buildHelper(directory)
  const camera = await startCameraMock()
  // The Connector's runtime file names no ports: the SDCP defaults are used.
  const sim = await startSdcpSimulator(
    {
      Id: 'fixture',
      Data: {
        Name: 'Journey',
        MachineName: SDCP_JOURNEY_MODEL,
        MainboardIP: HOST,
        MainboardID: SDCP_JOURNEY_BOARD,
        ProtocolVersion: 'V3.0.0',
        FirmwareVersion: SDCP_JOURNEY_FIRMWARE,
      },
    },
    { discoveryPort: 3000, websocketPort: 3030 },
  ).catch(async (error: unknown) => {
    await camera.close()
    throw error
  })
  const yesterday = Math.floor(Date.now() / 1000) - 86_400
  const machine = sim.simulate({
    family: 'resin',
    phase: 'printing',
    filename: 'journey.goo',
    currentLayer: 25,
    totalLayer: 100,
    videoUrl: camera.rtspUrl,
    history: [
      {
        TaskId: 'task-seed',
        TaskName: 'anterior.goo',
        BeginTime: yesterday,
        EndTime: yesterday + 3600,
        TaskStatus: 1,
      },
    ],
  })
  const frames = () =>
    sim.requests as { Data: { Cmd: number; Data: Record<string, unknown> } }[]
  return {
    host: HOST,
    port: Number(new URL(camera.rtspUrl).port),
    helper,
    machine,
    /** Every command except the status poll, in order. */
    commands: () =>
      frames()
        .map(({ Data }) => ({ cmd: Data.Cmd, data: Data.Data }))
        .filter(({ cmd }) => cmd !== 0),
    setProgress(percent: number) {
      machine.currentLayer = percent
      sim.report()
    },
    async close() {
      await sim.close()
      await camera.close()
    },
  }
}
