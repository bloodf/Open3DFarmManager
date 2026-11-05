import { createServer } from 'node:http'
import type { ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'

export async function createCameraServer() {
  const frame = await readFile(
    new URL('../fixtures/test-pattern.jpg', import.meta.url),
  )
  const streams = new Set<ServerResponse>()
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end()
      return
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/') {
      response.writeHead(404).end()
      return
    }
    const action = url.searchParams.get('action')
    if (action === 'snapshot') {
      response.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': frame.length,
      })
      response.end(request.method === 'HEAD' ? undefined : frame)
      return
    }
    if (action !== 'stream') {
      response.writeHead(404).end()
      return
    }
    if (streams.size >= 5) {
      response.writeHead(503).end()
      return
    }
    response.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
    })
    if (request.method === 'HEAD') {
      response.end()
      return
    }
    streams.add(response)
    const send = () => {
      if (response.destroyed || response.writableLength > 64 * 1024) {
        response.destroy()
        return
      }
      response.write(
        `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`,
      )
      response.write(frame)
      response.write('\r\n')
    }
    const timer = setInterval(send, 500)
    timer.unref()
    response.once('close', () => {
      clearInterval(timer)
      streams.delete(response)
    })
    send()
  })
  server.headersTimeout = 5000
  server.requestTimeout = 10_000
  return {
    server,
    get activeStreams() {
      return streams.size
    },
    async close() {
      for (const response of streams) response.destroy()
      if (!server.listening) return
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      })
    },
  }
}
