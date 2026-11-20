import { access } from 'node:fs/promises'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const builtEntry = join(root, 'apps/farm/.output/server/index.mjs')
const host = process.env.NITRO_HOST ?? '127.0.0.1'
const port = Number(process.env.NITRO_PORT ?? '3100')

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('NITRO_PORT must be a valid loopback port')
  process.exit(1)
}

function startStub() {
  const server = createServer((request, response) => {
    const path = request.url?.split('?')[0] ?? ''
    if (path === '/healthz') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ status: 'ok', checks: { process: 'ok' } }))
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('not found')
  })
  server.listen(port, host, () => {
    console.error(
      `[e2e-web-server] stub listening on http://${host}:${port} (farm build absent)`,
    )
  })
  const shutdown = () => {
    server.close(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

let usingBuilt = false
try {
  await access(builtEntry)
  usingBuilt = true
} catch {
  startStub()
}

if (usingBuilt) {
  const child = spawn(process.execPath, [builtEntry], {
    env: { ...process.env, NITRO_HOST: host, NITRO_PORT: String(port) },
    stdio: 'inherit',
  })
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    process.exit(code ?? 1)
  })
  const forward = (signal) => {
    if (!child.killed) child.kill(signal)
  }
  process.on('SIGINT', () => forward('SIGINT'))
  process.on('SIGTERM', () => forward('SIGTERM'))
}
