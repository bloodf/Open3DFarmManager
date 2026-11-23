import { createServer } from 'node:http'
import { once } from 'node:events'

const vendor = {
  id: 1,
  registered: '2026-11-21T00:00:00Z',
  name: 'Filamentos da Jornada',
  extra: {},
}
const filament = {
  id: 1,
  registered: '2026-11-21T00:00:00Z',
  name: 'PLA Azul Jornada',
  vendor,
  material: 'PLA',
  density: 1.24,
  diameter: 1.75,
  weight: 1000,
  price: 100,
  color_hex: '0055AA',
  extra: {},
}
const spool = {
  id: 1,
  registered: '2026-11-21T00:00:00Z',
  filament,
  initial_weight: 1000,
  used_weight: 0,
  used_length: 0,
  price: 100,
  location: 'Estante da jornada',
  archived: false,
  extra: {},
}

export async function startSpoolmanMock() {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const data: unknown =
      path === '/api/v1/info' || path === '/api/v1/setting/'
        ? {}
        : /^\/api\/v1\/field\//.test(path)
          ? []
          : path === '/api/v1/vendor'
            ? [vendor]
            : path === '/api/v1/filament'
              ? [filament]
              : path === '/api/v1/spool'
                ? [spool]
                : undefined
    if (data === undefined) {
      response.writeHead(404).end(JSON.stringify({ detail: 'Not Found' }))
      return
    }
    response.end(JSON.stringify(data))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Mock did not bind')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      server.close()
      await once(server, 'close')
    },
  }
}
