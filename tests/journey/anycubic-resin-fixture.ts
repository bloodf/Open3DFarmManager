// Synthetic Photon P1 Max for the journey: report shapes follow the public
// captures cited in packages/connector/src/anycubic-resin/models.ts, with
// synthetic identity, credentials and video tags. Not hardware evidence.
import { startPhotonP1MaxSimulator } from '../../packages/sim-tools/src/anycubic-resin-simulator.ts'
import handshake from '../fixtures/anycubic-resin/p1-max-handshake.json' with { type: 'json' }
import { createJourneyFlvEncoder } from './camera-encoder.ts'

export async function startAnycubicResinFixture() {
  const encoder = await createJourneyFlvEncoder()
  const simulator = await startPhotonP1MaxSimulator({
    ...handshake,
    liveStream: true,
  }).catch(async (error) => {
    await encoder.dispose()
    throw error
  })
  simulator.startJob('journey.pp1m', 25, 174)
  const origin = `http://${simulator.host}:${simulator.port}`
  return {
    simulator,
    encoder,
    origin,
    password: handshake.credentials.password,
    binding: {
      family: 'anycubic-resin' as const,
      origin,
      pinSha256: simulator.pinSha256,
      brokerPort: simulator.brokerPort,
      cameraPort: simulator.cameraPort,
      simulated: true,
      expect: {
        serial: handshake.identity.cn,
        model: handshake.identity.modelName,
      },
    },
    camera(assignmentId: string) {
      return {
        helper: { path: encoder.path, sha256: encoder.sha256 },
        maxSessions: 1,
        cameras: [
          {
            cameraId: 'journey-camera',
            assignmentId,
            source: {
              kind: 'anycubic-photon-resin',
              address: simulator.host,
              port: simulator.cameraPort,
            },
          },
        ],
      }
    },
    async close() {
      await Promise.all([simulator.close(), encoder.dispose()])
    },
  }
}
