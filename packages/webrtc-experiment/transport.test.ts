import { expect, test } from 'bun:test'
import { chromium, type Browser } from '@playwright/test'
import type { Scenario } from './fixture'

test('native encrypted DataChannel verifies synthetic identity and fails closed', async () => {
  const bundle = await Bun.build({
    entrypoints: [new URL('./fixture.ts', import.meta.url).pathname],
    target: 'browser',
  })
  if (!bundle.success || !bundle.outputs[0])
    throw Error('Browser bundle failed')
  const script = await bundle.outputs[0].text()
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
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
    },
  })
  let browser: Browser | undefined
  try {
    browser = await chromium.launch({ headless: true })
    console.info(JSON.stringify({ chromium: browser.version() }))
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.port}`)
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
      server.stop(true)
    }
  }
}, 60000)
