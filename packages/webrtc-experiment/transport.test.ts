import { expect, test } from 'vitest'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import { chromium, type Browser } from '@playwright/test'
import { once } from 'node:events'
import type { Scenario } from './fixture'

test('native encrypted DataChannel verifies synthetic identity and fails closed', async () => {
  const bundle = await build({
    entryPoints: [new URL('./fixture.ts', import.meta.url).pathname],
    bundle: true,
    platform: 'browser',
    write: false,
  })
  const script = bundle.outputFiles[0]!.text
  let received: (request: Request) => Response | Promise<Response> = () =>
    new Response(null, { status: 404 })
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      void (async () => {
        const request = new Request(
          `http://${req.headers.host ?? '127.0.0.1'}${req.url ?? '/'}`,
          {
            method: req.method ?? 'GET',
            headers: Object.entries(req.headers).flatMap(([name, value]) =>
              value === undefined
                ? []
                : (Array.isArray(value) ? value : [value]).map(
                    (item) => [name, item] satisfies [string, string],
                  ),
            ),
          },
        )
        const response = await received(request)
        res.writeHead(
          response.status,
          Object.fromEntries(response.headers.entries()),
        )
        res.end(Buffer.from(await response.arrayBuffer()))
      })()
    })
  })
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
  } catch (error) {
    server.closeAllConnections()
    server.close()
    throw error
  }
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw Error('Missing fixture port')
  }
  const { port } = address
  received = (request) => {
    if (request.method !== 'GET')
      return new Response('Somente leitura', { status: 405 })
    const path = new URL(request.url).pathname
    if (path !== '/' && path !== '/fixture.js')
      return new Response('Não encontrado', { status: 404 })
    return path === '/fixture.js'
      ? new Response(script, {
          headers: { 'Content-Type': 'text/javascript' },
        })
      : new Response(
          '<!doctype html><html lang="pt-BR"><title>Experimento sintético WebRTC</title><body>Somente dados sintéticos.</body></html>',
          { headers: { 'Content-Type': 'text/html' } },
        )
  }
  let browser: Browser | undefined
  try {
    browser = await chromium.launch({ headless: true })
    console.info(JSON.stringify({ chromium: browser.version() }))
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${port}`)
    for (const scenario of [
      'valid',
      'wrong-peer',
      'substitution',
      'replay',
      'timeout',
      'closed',
      'peer-closed',
    ] satisfies Scenario[]) {
      const result = await page.evaluate(async (scenario) => {
        const url = '/fixture.js'
        const fixture: typeof import('./fixture') = await import(url)
        return fixture.runScenario(scenario)
      }, scenario)
      console.info(JSON.stringify(result))
      expect(result.iceServers).toEqual([[], []])
      expect(result.fingerprints).toHaveLength(2)
      if (scenario !== 'closed' && scenario !== 'peer-closed') {
        expect(result.dtls).toEqual(['connected', 'connected'])
        expect(result.candidates).toHaveLength(2)
        for (const pair of result.candidates) {
          expect(pair?.local).toBe('host')
          // mDNS host resolution can be reported as peer-reflexive ICE.
          expect(['host', 'prflx']).toContain(pair?.remote ?? '')
        }
      }
      if (scenario === 'valid') {
        expect(result.states).toEqual({
          browser: 'verified',
          connector: 'verified',
        })
        expect(result.accepted).toEqual(['fixture-idle'])
        expect(result.connection).toEqual(['connected', 'connected'])
      } else {
        expect(result.states).toEqual({
          browser: 'readonly',
          connector: 'readonly',
        })
        expect(result.accepted).toEqual([])
        if (scenario === 'peer-closed')
          expect(result.connection[0]).toBe('closed')
        if (scenario === 'timeout')
          expect(result.rejected).toEqual([
            'deadline',
            'proof',
            'synthetic-only',
          ])
        else if (scenario !== 'closed' && scenario !== 'peer-closed') {
          expect(result.connection).toEqual(['connected', 'connected'])
          expect(result.rejected).toEqual(['identity-or-transcript'])
        }
      }
    }
  } finally {
    try {
      await browser?.close()
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  }
}, 60000)
