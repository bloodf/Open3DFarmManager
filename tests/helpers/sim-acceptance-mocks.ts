import { startCameraMock } from '../../packages/sim-tools/src/camera-mock.ts'
import { startMoonrakerMock } from '../../packages/sim-tools/src/mocks/moonraker-mock.ts'
import { startSpoolmanMock } from '../../packages/sim-tools/src/mocks/spoolman-mock.ts'

export function mockSimulatorStack() {
  const stops: (() => Promise<void>)[] = []
  let origins: Record<
    'sv06' | 'u1' | 'sv06Cam' | 'u1Cam' | 'camera' | 'spoolman',
    string
  >
  return {
    get origins() {
      return origins
    },
    async up() {
      const camera = await startCameraMock()
      stops.push(() => camera.close())
      const sv06 = await startMoonrakerMock({ profile: 'sv06' })
      stops.push(() => sv06.close())
      const u1 = await startMoonrakerMock({ profile: 'u1' })
      stops.push(() => u1.close())
      const spoolman = await startSpoolmanMock()
      stops.push(() => spoolman.close())
      origins = {
        sv06: sv06.origin,
        u1: u1.origin,
        sv06Cam: camera.cameraUrl,
        u1Cam: camera.cameraUrl,
        camera: camera.cameraUrl,
        spoolman: spoolman.origin,
      }
    },
    async down() {
      await Promise.all(stops.splice(0).map((stop) => stop()))
    },
    async logs() {
      return 'Loopback simulator mocks have no container logs'
    },
  }
}
