import { expect, it } from 'vitest'
import { startMoonrakerMock } from '../../packages/sim-tools/src/mocks/index.ts'
import { startCameraMock } from '../../packages/sim-tools/src/camera-mock.ts'
import { createMoonrakerDetailStream } from '../../packages/connector/src/moonraker/detail-stream.ts'
import { PrinterDetailUpdate } from '../../packages/farm-protocol/src/printer-detail.ts'

const startMock = startMoonrakerMock
type Webcam = NonNullable<
  NonNullable<Parameters<typeof startMock>[0]>['webcams']
>[number]

it('lists both cameras with their orientation over the detail socket without exposing URLs', async () => {
  function startMoonrakerMock({
    webcams,
  }: {
    webcams: readonly (Omit<Webcam, 'stream_url' | 'snapshot_url'> &
      Partial<Pick<Webcam, 'stream_url' | 'snapshot_url'>>)[]
  }) {
    return startMock({
      webcams: webcams.map((webcam) => ({
        stream_url: '',
        snapshot_url: '',
        ...webcam,
      })),
    })
  }

  const camera = await startCameraMock()
  try {
    const moonraker = await startMoonrakerMock({
      webcams: [
        { name: 'Mesa', uid: 'mesa', stream_url: camera.rtspUrl },
        {
          name: 'Bico',
          uid: 'bico',
          snapshot_url: `${camera.cameraUrl}/?action=snapshot`,
          rotation: 90,
          flip_horizontal: true,
          flip_vertical: true,
        },
      ],
    })
    try {
      const detail = createMoonrakerDetailStream({
        origin: moonraker.origin,
        printerKey: 'sv06',
        limits: {
          maxMessageBytes: 65536,
          connectTimeoutMs: 1000,
          requestTimeoutMs: 1000,
          staleAfterMs: 1000,
          reconnectMinMs: 50,
          reconnectMaxMs: 100,
        },
      })
      let stop: (() => void) | undefined
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        const frame = await new Promise<
          ReturnType<typeof PrinterDetailUpdate.parse>
        >((resolve, reject) => {
          timeout = setTimeout(
            () => reject(Error('Webcam catalogue timed out')),
            2000,
          )
          stop = detail.subscribe((value) => {
            const parsed = PrinterDetailUpdate.parse(value)
            if (parsed.capabilities.includes('webcams')) resolve(parsed)
          })
        })
        expect(frame.detail.webcams).toEqual([
          {
            uid: 'mesa',
            name: 'Mesa',
            enabled: true,
            rotation: 0,
            flipHorizontal: false,
            flipVertical: false,
          },
          {
            uid: 'bico',
            name: 'Bico',
            enabled: true,
            rotation: 90,
            flipHorizontal: true,
            flipVertical: true,
          },
        ])
      } finally {
        clearTimeout(timeout)
        stop?.()
      }
    } finally {
      await moonraker.close()
    }
  } finally {
    await camera.close()
  }
})
