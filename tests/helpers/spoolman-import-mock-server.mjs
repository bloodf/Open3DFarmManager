// Mock of an existing Spoolman installation for the import evidence run.
// It runs only inside a task-owned Docker container (see
// scripts/test-spool-library-import.mjs) and speaks just the read endpoints the
// importer uses, plus a small control surface under /__mock for the test.
//
//   PUT  /__mock/state   {vendors, filaments, spools, fields, settings}
//   PUT  /__mock/mode    {token?, fail?: {path, status, after?}, redirect?, plain?, huge?}
//   GET  /__mock/requests  every request seen (method, path, whether Authorization matched)
//
// Data shapes follow the pinned Spoolman 0.27.1 API.
import { createServer } from 'node:http'

let state = { vendors: [], filaments: [], spools: [], fields: {}, settings: {} }
let mode = {}
const seen = []
const hits = new Map()

const json = (res, status, body, headers = {}) => {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    ...headers,
  })
  res.end(text)
}
const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })

process.on('uncaughtException', () => {})

createServer(async (req, res) => {
  req.on('error', () => {})
  res.on('error', () => {})
  const url = new URL(req.url, 'http://mock')
  const path = url.pathname
  if (path.startsWith('/__mock/')) {
    if (path === '/__mock/requests') return json(res, 200, seen)
    const body = JSON.parse((await readBody(req)) || '{}')
    if (path === '/__mock/state') state = body
    else if (path === '/__mock/mode') {
      mode = body
      hits.clear()
    }
    return json(res, 200, { ok: true })
  }
  const authorized =
    !mode.token || req.headers.authorization === `Bearer ${mode.token}`
  seen.push({
    method: req.method,
    path: path + url.search,
    authorization: req.headers.authorization ? 'sent' : 'absent',
    authorized,
  })
  if (req.method !== 'GET') return json(res, 405, { message: 'read only mock' })
  if (!authorized) return json(res, 401, { message: 'unauthorized' })
  if (mode.redirect) {
    res.writeHead(302, { location: 'http://127.0.0.1:1/elsewhere' })
    return res.end()
  }
  if (mode.plain) {
    res.writeHead(200, { 'content-type': 'text/html' })
    return res.end('<html>not spoolman</html>')
  }
  if (mode.huge && path === '/api/v1/vendor') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write('[')
    const chunk = '{"id":1,"name":"' + 'x'.repeat(1_000_000) + '"},'
    for (let i = 0; i < 20; i++) res.write(chunk)
    return res.end('{}]')
  }
  if (mode.fail && path.startsWith(mode.fail.path)) {
    const n = (hits.get(mode.fail.path) ?? 0) + 1
    hits.set(mode.fail.path, n)
    if (n > (mode.fail.after ?? 0))
      return json(res, mode.fail.status, { message: 'injected failure' })
  }
  const page = (items) => {
    const limit = url.searchParams.has('limit')
      ? Number(url.searchParams.get('limit'))
      : items.length
    const offset = Number(url.searchParams.get('offset') ?? 0)
    return json(res, 200, items.slice(offset, offset + limit), {
      'x-total-count': String(items.length),
    })
  }
  if (path === '/api/v1/info')
    return json(res, 200, { version: '0.27.1', db_type: 'sqlite' })
  if (path === '/api/v1/vendor') return page(state.vendors)
  if (path === '/api/v1/filament') return page(state.filaments)
  if (path === '/api/v1/spool') {
    const archived = url.searchParams.get('allow_archived') === 'true'
    return page(state.spools.filter((s) => archived || !s.archived))
  }
  const field = /^\/api\/v1\/field\/(vendor|filament|spool)$/.exec(path)
  if (field) return json(res, 200, state.fields[field[1]] ?? [])
  if (path === '/api/v1/setting/') return json(res, 200, state.settings)
  json(res, 404, { message: 'not found' })
}).listen(8000, '0.0.0.0')
