import { createRequire } from 'node:module'

const require = createRequire(
  new URL('../../connector/package.json', import.meta.url),
)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { WebSocketServer } = require('ws') as any

export async function createCrealitySimulator(
  initialFrame: object = { state: 0 },
) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  const received: string[] = []
  const requests: Array<{ method: string; params: Record<string, unknown> }> =
    []
  let currentFrame = { ...initialFrame } as Record<string, unknown>

  function broadcast(payload: object) {
    const data = JSON.stringify(payload)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const client of server.clients as Set<any>) {
      if (client.readyState === 1 /* OPEN */) {
        client.send(data)
      }
    }
  }

  function applyCommand(method: string, params: Record<string, unknown>) {
    requests.push({ method, params })
    if (method !== 'set' || !params) return

    if (params.pause === 1) {
      currentFrame.state = 2 // paused
    } else if (params.pause === 0) {
      currentFrame.state = 1 // printing
    } else if (params.stop === 1) {
      currentFrame.state = 0 // idle
    }

    if (typeof params.nozzleTempControl === 'number') {
      currentFrame.nozzleTemp2 = params.nozzleTempControl
    }
    if (
      params.bedTempControl &&
      typeof (params.bedTempControl as { val?: unknown }).val === 'number'
    ) {
      currentFrame.bedTemp2 = (params.bedTempControl as { val: number }).val
    }
    if (typeof params.boxTempControl === 'number') {
      currentFrame.boxTemp2 = params.boxTempControl
    }

    if (typeof params.fan === 'number') {
      currentFrame.fan = params.fan
    }
    if (typeof params.fanAuxiliary === 'number') {
      currentFrame.fanAuxiliary = params.fanAuxiliary
    }
    if (typeof params.fanCase === 'number') {
      currentFrame.fanCase = params.fanCase
    }
    if (typeof params.lightSw === 'number') {
      currentFrame.lightSw = params.lightSw
    }
    if (typeof params.autohome === 'string') {
      currentFrame.autohome = params.autohome
    }

    broadcast(currentFrame)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.on('connection', (socket: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    socket.on('message', (data: any) => {
      const raw = data.toString()
      received.push(raw)
      try {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object') {
          applyCommand(parsed.method, parsed.params)
        }
      } catch {
        // ignore malformed message in raw simulator stream
      }
    })
    socket.send(JSON.stringify(currentFrame))
  })

  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Missing address')

  return {
    port: address.port,
    received,
    requests,
    get state() {
      return { ...currentFrame }
    },
    disconnect() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const socket of server.clients as Set<any>) socket.terminate()
    },
    async close() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const socket of server.clients as Set<any>) socket.terminate()
      await new Promise<void>((resolve, reject) =>
        server.close((error: unknown) => (error ? reject(error) : resolve())),
      )
    },
  }
}
