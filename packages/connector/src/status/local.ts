import { createServer } from 'node:http'

export function parseStatusPort(value: string): number {
  if (!/^[1-9][0-9]{0,4}$/.test(value)) throw new Error('Invalid status port')
  const port = Number(value)
  if (port > 65535) throw new Error('Invalid status port')
  return port
}

export type LocalStatus = {
  queueDepth: number
  delivered: number
  retries: number
  credentialExpired: boolean
}

// Construct the public response field by field. Never serialize runtime config.
export function projectStatus(value: LocalStatus): LocalStatus {
  const count = (n: number) => (Number.isSafeInteger(n) && n >= 0 ? n : 0)
  return {
    queueDepth: count(value.queueDepth),
    delivered: count(value.delivered),
    retries: count(value.retries),
    credentialExpired: value.credentialExpired === true,
  }
}

export async function openLocalStatus(input: {
  port: number
  read: () => LocalStatus
  onError: (error: Error) => void
}) {
  parseStatusPort(String(input.port))
  const authority = `127.0.0.1:${input.port}`
  const origin = `http://${authority}`
  const server = createServer({ maxHeaderSize: 8192 }, (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    )
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Connection', 'close')
    const hostCount = req.rawHeaders.filter(
      (value, index) => index % 2 === 0 && value.toLowerCase() === 'host',
    ).length
    if (
      hostCount !== 1 ||
      req.headers.host !== authority ||
      (req.headers.origin !== undefined && req.headers.origin !== origin) ||
      (req.headers['sec-fetch-site'] !== undefined &&
        !['none', 'same-origin'].includes(
          String(req.headers['sec-fetch-site']),
        ))
    ) {
      res.writeHead(403).end()
      return
    }
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET' }).end()
      return
    }
    if (req.url !== '/' && req.url !== '/status') {
      res.writeHead(404).end()
      return
    }
    try {
      const status = projectStatus(input.read())
      if (req.url === '/status') {
        res
          .writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          .end(JSON.stringify(status))
      } else {
        // Only validated numbers and fixed text enter the static document.
        res
          .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          .end(
            `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Estado local do Connector</title><main><h1>Estado local do Connector</h1><p>Somente leitura. Atualize a página para consultar novamente.</p><dl><dt>Registros na fila</dt><dd>${status.queueDepth}</dd><dt>Registros enviados</dt><dd>${status.delivered}</dd><dt>Novas tentativas</dt><dd>${status.retries}</dd><dt>Credencial</dt><dd>${status.credentialExpired ? 'Expirada' : 'Válida'}</dd></dl><p>Estes dados descrevem o processo local. Não confirmam o estado de uma impressora.</p></main></html>`,
          )
      }
    } catch {
      res.writeHead(503).end()
    }
  })
  server.requestTimeout = 5000
  server.headersTimeout = 5000
  server.maxConnections = 16
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(input.port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  server.on('error', input.onError)
  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      }),
  }
}
