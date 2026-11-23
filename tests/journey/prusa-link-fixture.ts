import { readFile } from 'node:fs/promises'
import { startPrusaSimulator } from '../../packages/sim-tools/src/prusa-simulator.ts'

/** Only binds loopback and serves synthetic PrusaLink responses. */
export async function startPrusaLinkJourneyFixture() {
  const data = JSON.parse(
    await readFile(
      new URL('../fixtures/prusa/link.json', import.meta.url),
      'utf8',
    ),
  )
  const apiKey = 'journey-prusa-key'
  const requests: {
    method: string
    path: string
    authorized: boolean
    status: number
  }[] = []
  let state = 'PRINTING'
  let online = true
  const simulator = await startPrusaSimulator((req, res) => {
    const authorized = req.headers['x-api-key'] === apiKey
    const routes: Record<string, unknown> = {
      '/api/version': data.version,
      '/api/v1/info': data.info,
      '/api/v1/status': {
        ...data.status,
        printer: { ...data.status.printer, state },
      },
    }
    const path = req.url ?? ''
    const status = !authorized
      ? 401
      : !online
        ? 503
        : req.method !== 'GET' || !(path in routes)
          ? 404
          : 200
    requests.push({ method: req.method ?? '', path, authorized, status })
    res
      .writeHead(status, { 'content-type': 'application/json' })
      .end(status === 200 ? JSON.stringify(routes[path]) : '{}')
  })
  return {
    simulator,
    apiKey,
    requests,
    loseConnection: () => {
      online = false
    },
    recover: () => {
      state = 'IDLE'
      online = true
    },
    close: () => simulator.close(),
  }
}
