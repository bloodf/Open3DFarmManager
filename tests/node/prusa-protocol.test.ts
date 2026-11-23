import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import {
  createPrusaConnectLocal,
  createPrusaLink,
} from '../../packages/connector/src/prusa/index.ts'
import { startPrusaSimulator } from '../../packages/sim-tools/src/prusa-simulator.ts'

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/prusa/link.json', import.meta.url), 'utf8'),
)
const allow = { beforeSend: () => true }

test('PrusaLink status, snapshot and guarded operations use the documented wire contract', async (t) => {
  const writes: string[] = []
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/X9sAAAAASUVORK5CYII=',
    'base64',
  )
  const routes: Record<string, unknown> = {
    '/api/version': fixture.version,
    '/api/v1/info': fixture.info,
    '/api/v1/status': fixture.status,
  }
  const sim = await startPrusaSimulator(async (req, res) => {
    if (req.headers['x-api-key'] !== 'fixture-key') {
      res.writeHead(401).end()
      return
    }
    const path = req.url!
    if (req.method === 'GET') {
      if (path === '/api/v1/cameras/snap')
        res.writeHead(200, { 'Content-Type': 'image/png' }).end(png)
      else if (path in routes) res.end(JSON.stringify(routes[path]))
      else res.writeHead(404).end()
      return
    }
    writes.push(`${req.method} ${path}`)
    if (req.method === 'PUT' && path.startsWith('/api/v1/files/')) {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      if (
        req.headers['print-after-upload'] !== undefined ||
        req.headers.overwrite !== '?0' ||
        Buffer.concat(chunks).toString() !== 'G28\n'
      ) {
        res.writeHead(400).end()
        return
      }
      res.writeHead(201).end()
    } else res.writeHead(204).end()
  })
  t.after(sim.close)
  const link = createPrusaLink(sim.endpoint, 'fixture-key')
  assert.deepEqual(await link.discover(), {
    version: fixture.version,
    info: fixture.info,
  })
  assert.deepEqual(await link.status(), fixture.status)
  assert.deepEqual(await link.camera(), {
    contentType: 'image/png',
    bytes: new Uint8Array(png),
  })
  await assert.rejects(createPrusaLink(sim.endpoint, 'bad').status(), {
    status: 401,
  })
  await assert.rejects(
    link.start('usb', 'a.gcode', { beforeSend: () => false }),
    /denied/,
  )
  await assert.rejects(link.start('usb', '..', allow), /Invalid Prusa path/)
  await link.upload(
    'usb',
    'a b.gcode',
    new TextEncoder().encode('G28\n'),
    allow,
  )
  await link.start('usb', 'a b.gcode', allow)
  await link.control(42, 'pause', allow)
  await link.control(42, 'resume', allow)
  await link.control(42, 'cancel', allow)
  assert.deepEqual(writes, [
    'PUT /api/v1/files/usb/a%20b.gcode',
    'POST /api/v1/files/usb/a%20b.gcode',
    'PUT /api/v1/job/42/pause',
    'PUT /api/v1/job/42/resume',
    'DELETE /api/v1/job/42',
  ])
})

test('denial, disconnect, timeout and malformed replies stay failures', async (t) => {
  const writes: string[] = []
  const sim = await startPrusaSimulator((req, res) => {
    if (req.method === 'GET') {
      res.end('{"printer":{"state":false}}')
      return
    }
    writes.push(req.url!)
    if (req.url === '/api/v1/job/1/pause') req.socket.destroy()
    if (req.url === '/api/v1/job/3/pause') res.writeHead(409).end()
  })
  t.after(sim.close)
  const link = createPrusaLink(sim.endpoint, 'fixture-key', 500)
  await assert.rejects(link.status(), /Malformed Prusa printer state/)
  await assert.rejects(link.control(1, 'pause', allow), { code: 'ECONNRESET' })
  await assert.rejects(link.control(2, 'pause', allow), { code: 'ABORT_ERR' })
  await assert.rejects(link.control(3, 'pause', allow), { status: 409 })
  assert.deepEqual(writes, [
    '/api/v1/job/1/pause',
    '/api/v1/job/2/pause',
    '/api/v1/job/3/pause',
  ])
})

test('Connect Local lists devices and reads an identified device and its history', async (t) => {
  const observed = {
    id: 'printer-1',
    connected: true,
    issues: [],
    state: { '/state': 'PRINTING', '/temperature/bed': 59.9 },
  }
  const history = {
    items: [{ device_id: 'printer-1', id: 'job-2', state: 'FINISHED' }],
    cursor: 'next',
  }
  const sim = await startPrusaSimulator((req, res) => {
    if (req.headers.authorization !== 'Bearer fixture-token') {
      res.writeHead(403).end()
      return
    }
    if (req.method === 'GET' && req.url === '/api/v1/cameras/bench/snapshot') {
      res.writeHead(204).end()
      return
    }
    const routes: Record<string, unknown> = {
      '/api/v1/devices': { items: [observed] },
      '/api/v1/devices/printer-1': observed,
      '/api/v1/devices/printer-2': observed,
      '/api/v1/devices/printer-1/jobs/history?cursor=a%2Bb': history,
    }
    if (req.method !== 'GET' || !(req.url! in routes)) res.writeHead(404).end()
    else res.end(JSON.stringify(routes[req.url!]))
  })
  t.after(sim.close)
  const connect = createPrusaConnectLocal(sim.endpoint, 'fixture-token')
  assert.equal(await connect.camera('bench'), null)
  assert.deepEqual(await connect.discover(), { items: [observed] })
  assert.deepEqual(await connect.status('printer-1'), observed)
  assert.deepEqual(await connect.history('printer-1', 'a+b'), history)
  await assert.rejects(connect.status('printer-2'), /identity mismatch/)
  await assert.rejects(
    createPrusaConnectLocal(sim.endpoint, 'bad').discover(),
    { status: 403 },
  )
})
