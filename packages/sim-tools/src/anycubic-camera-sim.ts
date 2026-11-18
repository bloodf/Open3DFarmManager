// SPDX-License-Identifier: MIT
import { startHttpMock } from './mocks/http-mock.ts'
import type { ScenarioStep } from './mocks/scenario.ts'

export interface AnycubicCameraSimOptions {
  jpeg: Buffer
  auth?: { username: string; password: string } | undefined
  flv?: Buffer | undefined
  token?: string | undefined
  frameCount?: number | undefined
  failFirst?: boolean | undefined
  malformed?: boolean | undefined
  scenario?: ScenarioStep[] | undefined
}

/** Loopback-only fixture derived from docs/protocols/anycubic-camera.md. */
export async function startAnycubicCameraSim(input: AnycubicCameraSimOptions) {
  let requests = 0
  let authenticated = 0
  let captures = 0
  let stops = 0
  let active = false
  const token = input.token ?? 'synthetic-session'
  const expectedAuth = input.auth
    ? 'Basic ' +
      Buffer.from(input.auth.username + ':' + input.auth.password).toString(
        'base64',
      )
    : undefined

  let httpMockRef: Awaited<ReturnType<typeof startHttpMock>> | undefined

  const httpMock = await startHttpMock({
    scenario: input.scenario,
    handler: async (req, res) => {
      requests++
      if (expectedAuth && req.headers.authorization !== expectedAuth) {
        res.writeHead(401).end()
        return
      }
      authenticated++
      if (input.failFirst && requests === 1) {
        res.writeHead(503).end()
        return
      }
      if (req.url === '/?action=stream') {
        const ackFault = httpMockRef?.control.faults.matchFault({
          path: '/',
          method: 'ACK',
        })
        if (ackFault) {
          if (ackFault.type === 'drop') {
            req.socket.destroy()
            return
          }
          if (ackFault.type === 'refuse') {
            res.writeHead(ackFault.statusCode ?? 503).end()
            return
          }
          if (ackFault.type === 'stall') {
            return
          }
          if (ackFault.type === 'delay') {
            await new Promise((r) => setTimeout(r, ackFault.delayMs))
          }
        }

        const reportFault = httpMockRef?.control.faults.matchFault({
          path: '/',
          method: 'REPORT',
        })
        if (reportFault) {
          if (reportFault.type === 'drop') {
            req.socket.destroy()
            return
          }
          if (reportFault.type === 'refuse') {
            res.writeHead(reportFault.statusCode ?? 503).end()
            return
          }
          if (reportFault.type === 'stall') {
            return
          }
          if (reportFault.type === 'delay') {
            await new Promise((r) => setTimeout(r, reportFault.delayMs))
          }
        }

        const framePayload =
          reportFault?.type === 'malformed'
            ? reportFault.payload
              ? Buffer.isBuffer(reportFault.payload)
                ? reportFault.payload
                : Buffer.from(reportFault.payload)
              : Buffer.from('invalid')
            : input.malformed
              ? Buffer.from('invalid')
              : input.jpeg

        res.writeHead(200, {
          'content-type': 'multipart/x-mixed-replace; boundary=frame',
        })
        for (let i = 0; i < (input.frameCount ?? 24); i++) {
          res.write('--frame\r\nContent-Type: image/jpeg\r\n\r\n')
          res.write(framePayload)
          res.write('\r\n')
        }
        res.end('--frame--\r\n')
      } else if (req.url === '/live/' + token && active && input.flv) {
        res.writeHead(200, { 'content-type': 'video/x-flv' })
        res.end(input.flv)
      } else {
        res.writeHead(404).end()
      }
    },
  })
  httpMockRef = httpMock

  const port = httpMock.ports.default

  return {
    host: '127.0.0.1',
    port,
    origin: httpMock.origin,
    ports: httpMock.ports,
    control: httpMock.control,
    calls: httpMock.calls,
    get requests() {
      return requests
    },
    get authenticated() {
      return authenticated
    },
    get captures() {
      return captures
    },
    get stops() {
      return stops
    },
    async startCapture(signal: AbortSignal) {
      signal.throwIfAborted()
      captures++
      active = true
      const url = new URL(`http://127.0.0.1:${port}/live/${token}`)
      if (input.auth) {
        url.username = input.auth.username
        url.password = input.auth.password
      }
      return url.toString()
    },
    async stopCapture() {
      stops++
      active = false
    },
    close() {
      return httpMock.close()
    },
  }
}
