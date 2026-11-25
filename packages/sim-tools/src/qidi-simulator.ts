import { createServer } from 'node:http'
import { once } from 'node:events'

/** Moonraker HTTP simulator. Its ephemeral listener is loopback-only. */
export async function startQidiSimulator(fixtures: {
  info: unknown
  state: unknown
  history: unknown
  snapshot: Uint8Array
}) {
  let fault: 'disconnect' | 'timeout' | 'malformed' | undefined
  const requests: string[] = []
  const uploads: string[] = []
  const files = new Map<string, Buffer>()
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    requests.push(`${request.method} ${request.url}`)
    if (
      request.headers['x-api-key'] !== 'fixture-key' &&
      request.headers.authorization !== 'Bearer fixture-token'
    ) {
      response.writeHead(401).end()
      return
    }
    switch (fault) {
      case 'disconnect':
        request.socket.destroy()
        return
      case 'timeout':
        return
      case 'malformed':
        response.writeHead(200, { 'content-type': 'application/json' }).end('{')
        return
    }
    if (request.method === 'POST' && request.url === '/server/files/upload') {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk)
      const bytes = Buffer.concat(chunks)
      try {
        const form = await new Response(new Uint8Array(bytes), {
          headers: { 'content-type': request.headers['content-type'] ?? '' },
        }).formData()
        const file = form.get('file')
        if (
          form.get('root') !== 'gcodes' ||
          form.has('print') ||
          !(file instanceof File)
        ) {
          response.writeHead(400).end()
          return
        }
        files.set(
          encodeURIComponent(file.name),
          Buffer.from(await file.arrayBuffer()),
        )
      } catch {
        response.writeHead(400).end()
        return
      }
      uploads.push(bytes.toString())
      response
        .writeHead(201, { 'content-type': 'application/json' })
        .end(JSON.stringify({ result: { print_started: false } }))
      return
    }
    if (request.method !== 'GET') {
      response.writeHead(405).end()
      return
    }
    if (request.url === '/webcam/?action=snapshot') {
      response
        .writeHead(200, { 'content-type': 'image/jpeg' })
        .end(fixtures.snapshot)
      return
    }
    // https://moonraker.readthedocs.io/en/latest/external_api/file_manager/
    if (url.pathname.startsWith('/server/files/gcodes/')) {
      const encodedName = url.pathname.slice('/server/files/gcodes/'.length)
      const file = files.get(encodedName)
      if (!file) response.writeHead(404).end()
      else
        response
          .writeHead(200, { 'content-type': 'application/octet-stream' })
          .end(file)
      return
    }
    if (
      url.pathname === '/printer/objects/query' &&
      fixtures.state !== undefined
    ) {
      const state = fixtures.state as {
        result?: { status?: Record<string, unknown> }
      }
      if (
        state?.result?.status &&
        typeof state.result.status === 'object' &&
        !Array.isArray(state.result.status)
      ) {
        const status = Object.fromEntries(
          Object.entries(state.result.status).filter(([name]) =>
            url.searchParams.has(name),
          ),
        )
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(
            JSON.stringify({ ...state, result: { ...state.result, status } }),
          )
        return
      }
    }
    const payloads: Record<string, unknown> = {
      '/server/info': fixtures.info,
      '/printer/objects/query': fixtures.state,
      '/server/history/list?limit=50&order=desc': fixtures.history,
    }
    const path =
      url.pathname === '/printer/objects/query'
        ? url.pathname
        : (request.url ?? '')
    const payload = Object.hasOwn(payloads, path) ? payloads[path] : undefined
    if (payload === undefined) {
      response.writeHead(404).end()
      return
    }
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify(payload))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Expected TCP listener')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    uploads,
    setFault(value: typeof fault) {
      fault = value
    },
    close() {
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
      server.closeAllConnections()
      return closed
    },
  }
}
