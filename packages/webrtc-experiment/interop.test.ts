import { browserBundle } from '../../tests/helpers/browser-bundle.ts'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { expect, chromium, type Browser } from '@playwright/test'
import { randomNonce } from '../connector/src/webrtc/synthetic-session.ts'
import type { InteropScenario } from './interop-browser.ts'
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
function textField(value: unknown, field: string) {
  if (!record(value) || typeof value[field] !== 'string')
    throw Error('Missing fixture field ' + field)
  return value[field]
}
function readonly(value: unknown) {
  return record(value) && record(value.state) && value.state.kind === 'readonly'
}
function reason(value: unknown) {
  return record(value) &&
    record(value.state) &&
    typeof value.state.reason === 'string'
    ? value.state.reason
    : undefined
}
function accepted(value: unknown) {
  return (
    record(value) &&
    Array.isArray(value.accepted) &&
    value.accepted.length === 1
  )
}
async function until<T>(
  read: () => Promise<T>,
  condition: (value: T) => boolean,
  deadline = 12000,
) {
  const started = performance.now()
  while (performance.now() - started < deadline) {
    const value = await read()
    if (condition(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  throw Error('Fixture observation deadline')
}
function assertBounds(value: unknown) {
  if (
    !record(value) ||
    !record(value.work) ||
    !Array.isArray(value.accepted) ||
    !Array.isArray(value.rejected)
  )
    throw Error('Missing bounded observation')
  expect(value.work.maxPending).toBeLessThanOrEqual(8)
  expect(value.work.maxRetainedBytes).toBeLessThanOrEqual(32768)
  expect(value.work.admitted).toBeLessThanOrEqual(1024)
  expect(value.work.pending).toBe(0)
  expect(value.work.retainedBytes).toBe(0)
  expect(value.accepted.length).toBeLessThanOrEqual(16)
  expect(value.rejected.length).toBeLessThanOrEqual(8)
  expect(JSON.stringify(value).length).toBeLessThan(8192)
}
class FixtureProcess {
  process: ChildProcessWithoutNullStreams
  #pending:
    | { resolve: (value: unknown) => void; reject: (error: Error) => void }
    | undefined
  stderr = ''
  #exited: Promise<void>
  constructor(runtime: string) {
    if (runtime !== 'node' || process.versions.bun)
      throw Error('Node runtime required')
    this.process = spawn(
      process.execPath,
      [new URL('./interop-child.ts', import.meta.url).pathname],
      { stdio: 'pipe' },
    )
    this.#exited = new Promise((resolve) => {
      this.process.once('exit', (code, signal) => {
        console.info(
          JSON.stringify({
            event: 'fixture-exit',
            runtime,
            pid: this.process.pid,
            code,
            signal,
            stderr: this.stderr,
          }),
        )
        resolve()
      })
      this.process.once('error', () => resolve())
    })
    this.process.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + String(chunk)).slice(-8192)
    })
    createInterface({ input: this.process.stdout }).on('line', (line) => {
      const pending = this.#pending
      this.#pending = undefined
      if (!pending) return
      try {
        if (line.length > 65536) throw Error('Fixture response limit')
        const value: unknown = JSON.parse(line)
        if (record(value) && 'error' in value)
          throw Error(JSON.stringify(value))
        pending.resolve(value)
      } catch (error) {
        pending.reject(error instanceof Error ? error : Error('Fixture JSON'))
      }
    })
    this.process.stdin.on('error', (error) => this.#pending?.reject(error))
    this.process.on('error', (error) => this.#pending?.reject(error))
    this.process.on('exit', (code) =>
      this.#pending?.reject(
        Error(`Fixture process exited ${code}: ${this.stderr}`),
      ),
    )
  }
  async request(value: unknown) {
    if (this.process.exitCode !== null || this.process.signalCode !== null)
      throw Error('Fixture already exited: ' + this.stderr)
    if (this.#pending) throw Error('Concurrent fixture IPC')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await new Promise<unknown>((resolve, reject) => {
        this.#pending = { resolve, reject }
        timer = setTimeout(() => {
          this.#pending = undefined
          reject(Error('Fixture IPC deadline: ' + this.stderr))
        }, 10000)
        this.process.stdin.write(JSON.stringify(value) + '\n')
      })
    } finally {
      clearTimeout(timer)
    }
  }
  async stop() {
    if (this.process.exitCode !== null || this.process.signalCode !== null)
      return
    let timer: ReturnType<typeof setTimeout> | undefined
    const killed = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        this.process.kill('SIGKILL')
        resolve()
      }, 3000)
    })
    this.process.stdin.end()
    try {
      await Promise.race([this.#exited, killed])
    } finally {
      clearTimeout(timer)
    }
    if (this.process.exitCode === null && this.process.signalCode === null) {
      await Promise.race([
        this.#exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(Error('Fixture kill disposal deadline')),
            1000,
          )
        }),
      ]).finally(() => clearTimeout(timer))
    }
  }
}

test(
  'Chromium exchanges only synthetic RTC messages with actual Connector runtime',
  { timeout: 120000 },
  async () => {
    if (process.versions.bun) throw Error('Run this harness with node --test')
    const started = performance.now()
    const probe = process.env.WEBRTC_INTEROP_PROBE
    if (process.versions.bun) throw Error('Node runtime required')
    const script = await browserBundle(
      new URL('./interop-browser.ts', import.meta.url).pathname,
    )
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      if (request.method !== 'GET') {
        response.writeHead(405)
        response.end('Somente leitura')
        return
      }
      if (path === '/interop.js') {
        response.writeHead(200, { 'Content-Type': 'text/javascript' })
        response.end(script)
        return
      }
      if (path === '/') {
        response.writeHead(200, { 'Content-Type': 'text/html' })
        response.end(
          '<!doctype html><html lang="pt-BR"><title>Interoperação sintética</title><body>Somente dados sintéticos.</body></html>',
        )
        return
      }
      response.writeHead(404)
      response.end('Não encontrado')
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
      throw Error('Missing static fixture port')
    }
    const staticPort = address.port
    let browser: Browser | undefined
    let child: FixtureProcess | undefined
    try {
      browser = await chromium.launch({ headless: true })
      console.info(
        JSON.stringify({
          chromium: browser.version(),
          staticPort,
          probe,
          driver: process.version,
          elapsedMs: performance.now() - started,
        }),
      )
      for (const runtime of ['node']) {
        child = new FixtureProcess(runtime)
        const hello = await child.request({ kind: 'hello' })
        const connectorSpki = textField(hello, 'spki')
        console.info(JSON.stringify({ runtime, hello }))
        const page = await browser.newPage()
        await page.goto(`http://127.0.0.1:${staticPort}`)
        const browserSpki = await page.evaluate(async () => {
          const path = '/interop.js'
          const fixture: typeof import('./interop-browser.ts') = await import(
            path
          )
          return fixture.publicIdentity()
        })
        const malformedScope = {
          session: randomNonce(),
          browserNonce: randomNonce(),
          connectorNonce: randomNonce(),
          browserSpki,
          connectorSpki,
        }
        await child.request({ kind: 'offer', scope: malformedScope })
        await expect(
          child.request({ kind: 'answer', sdp: 'invalid-sdp' }),
        ).rejects.toThrow('Native answer rejected')
        expect(await child.request({ kind: 'snapshot' })).toMatchObject({
          state: { kind: 'readonly', reason: 'remote-description-failed' },
          connection: 'closed',
          accepted: [],
        })
        await expect(
          child.request({ kind: 'answer', sdp: 'invalid-sdp' }),
        ).rejects.toThrow('terminal')
        const gatheringScope = {
          session: randomNonce(),
          browserNonce: randomNonce(),
          connectorNonce: randomNonce(),
          browserSpki,
          connectorSpki,
        }
        await expect(
          child.request({
            kind: 'offer',
            scope: gatheringScope,
            deadlineMs: 100,
            holdGathering: true,
          }),
        ).rejects.toThrow('Adapter terminal')
        expect(await child.request({ kind: 'snapshot' })).toMatchObject({
          state: { kind: 'readonly', reason: 'deadline' },
          connection: 'closed',
          resources: {
            closeCount: 1,
            receiveEnabled: false,
            authTimer: false,
            lifetimeTimer: false,
          },
        })
        const abandonedScope = {
          session: randomNonce(),
          browserNonce: randomNonce(),
          connectorNonce: randomNonce(),
          browserSpki,
          connectorSpki,
        }
        await child.request({
          kind: 'offer',
          scope: abandonedScope,
          deadlineMs: 300,
        })
        const expiredOffer = await until(
          () =>
            child
              ? child.request({ kind: 'snapshot' })
              : Promise.reject(Error('Child missing')),
          readonly,
        )
        expect(expiredOffer).toMatchObject({
          state: { kind: 'readonly', reason: 'deadline' },
          connection: 'closed',
          accepted: [],
          resources: {
            closeCount: 1,
            receiveEnabled: false,
            authTimer: false,
            lifetimeTimer: false,
          },
        })
        expect(await child.request({ kind: 'close' })).toEqual(expiredOffer)
        expect(await child.request({ kind: 'close' })).toEqual(expiredOffer)
        await expect(
          child.request({ kind: 'answer', sdp: '' }),
        ).rejects.toThrow('terminal')
        const scenarios: InteropScenario[] =
          probe === '1'
            ? ['valid']
            : probe === 'negative'
              ? ['valid', 'wrong-identity', 'substitution', 'replay']
              : probe === 'bounds'
                ? [
                    'valid',
                    'pre-cert-overload',
                    'status-flood',
                    'tampered-offer',
                    'tampered-answer',
                  ]
                : [
                    'valid',
                    'wrong-identity',
                    'substitution',
                    'replay',
                    'timeout',
                    'closed',
                    'tampered-offer',
                    'tampered-answer',
                    'pre-cert-overload',
                    'status-flood',
                  ]
        for (const scenario of scenarios) {
          const scenarioStarted = performance.now()

          const scope = {
            session: randomNonce(),
            browserNonce: randomNonce(),
            connectorNonce: randomNonce(),
            browserSpki,
            connectorSpki,
          }
          const offer = await child.request({
            kind: 'offer',
            scope,
            lifetimeMs: scenario === 'valid' ? 1500 : 30000,
          })
          const originalSdp = textField(offer, 'sdp')
          const tamper = (sdp: string) =>
            sdp.replace(
              /a=fingerprint:sha-256 [0-9a-f:]+/gi,
              'a=fingerprint:sha-256 ' + '00:'.repeat(31) + '00',
            )
          if (scenario.startsWith('tampered-'))
            expect(tamper(originalSdp)).not.toBe(originalSdp)
          const sdp =
            scenario === 'tampered-offer' ? tamper(originalSdp) : originalSdp
          expect(textField(offer, 'type')).toBe('offer')
          const answer = await page.evaluate(
            async (input) => {
              const path = '/interop.js'
              const fixture: typeof import('./interop-browser.ts') =
                await import(path)
              return fixture.answer(input)
            },
            {
              scenario,
              scope,
              offer: { type: 'offer', sdp } satisfies {
                type: 'offer'
                sdp: string
              },
            },
          )
          if (scenario === 'tampered-answer')
            expect(tamper(answer.sdp ?? '')).not.toBe(answer.sdp)
          console.info(
            JSON.stringify({ stage: 'applying-answer', runtime, scenario }),
          )
          await child.request({
            kind: 'answer',
            sdp:
              scenario === 'tampered-answer'
                ? tamper(answer.sdp ?? '')
                : answer.sdp,
          })
          const readBrowser = () =>
            page.evaluate(async () => {
              const path = '/interop.js'
              const fixture: typeof import('./interop-browser.ts') =
                await import(path)
              return fixture.snapshot()
            })
          const readConnector = () =>
            child
              ? child.request({ kind: 'snapshot' })
              : Promise.reject(Error('Child missing'))
          if (scenario === 'pre-cert-overload') {
            await until(
              readBrowser,
              (value) => record(value) && value.channel === 'open',
            )
            await child.request({ kind: 'flood' })
            const browserResult = await until(readBrowser, readonly)
            const connectorResult = await until(readConnector, readonly)
            expect(browserResult).toMatchObject({
              state: { kind: 'readonly', reason: 'pending-limit' },
              accepted: [],
              received: 0,
              rtcProofsSent: 0,
              activationTasks: 1,
              fingerprintMatches: false,
              closeCount: 1,
              receiveEnabled: false,
              work: {
                admitted: 8,
                maxPending: 8,
                pending: 0,
                retainedBytes: 0,
              },
            })
            expect(connectorResult).toMatchObject({
              state: { kind: 'readonly' },
              accepted: [],
              resources: {
                closeCount: 1,
                receiveEnabled: false,
                authTimer: false,
                lifetimeTimer: false,
              },
            })
            assertBounds(browserResult)
            expect(await child.request({ kind: 'flood' })).toEqual({ sent: 0 })
            expect(await readBrowser()).toEqual(browserResult)
          } else if (
            scenario === 'valid' ||
            scenario === 'closed' ||
            scenario === 'status-flood'
          ) {
            const connectorResult = await until(readConnector, accepted)
            const browserResult = await until(readBrowser, accepted)
            console.info(
              JSON.stringify({
                runtime,
                scenario,
                connector: connectorResult,
                browser: browserResult,
              }),
            )
            expect(connectorResult).toMatchObject({
              state: { kind: 'verified' },
              accepted: ['fixture-idle'],
              connection: 'connected',
              fingerprintMatches: true,
              iceServers: [],
            })
            expect(browserResult).toMatchObject({
              state: { kind: 'verified' },
              accepted: ['fixture-idle'],
              connection: 'connected',
              dtls: 'connected',
              iceServers: [],
            })
            if (!record(connectorResult))
              throw Error('Connector snapshot missing')
            expect(connectorResult.actualRemoteFingerprint).toBe(
              connectorResult.expectedRemoteFingerprint,
            )
            expect(browserResult.actualRemoteFingerprint).toBe(
              browserResult.expectedRemoteFingerprint,
            )
            expect(browserResult.fingerprintMatches).toBe(true)
            if (
              !record(connectorResult) ||
              typeof connectorResult.receivedRtc !== 'number'
            )
              throw Error('RTC counters missing')
            expect(connectorResult.receivedRtc).toBeGreaterThanOrEqual(2)
            if (!record(connectorResult.candidates))
              throw Error('Native ICE pair missing')
            expect(['host', 'prflx']).toContain(
              String(connectorResult.candidates.local),
            )
            expect(['host', 'prflx']).toContain(
              String(connectorResult.candidates.remote),
            )
            expect(['host', 'prflx']).toContain(
              browserResult.candidates?.remote ?? '',
            )
            expect(['host', 'prflx']).toContain(
              browserResult.candidates?.local ?? '',
            )
            if (scenario === 'valid') {
              const expired = await until(readConnector, readonly, 4000)
              expect(expired).toMatchObject({
                state: { kind: 'readonly', reason: 'fixture-lifetime' },
                connection: 'closed',
                resources: {
                  closeCount: 1,
                  receiveEnabled: false,
                  authTimer: false,
                  lifetimeTimer: false,
                },
              })
              expect(await until(readBrowser, readonly)).toMatchObject({
                state: { kind: 'readonly' },
                connection: 'closed',
                closeCount: 1,
                receiveEnabled: false,
              })
            }
            if (scenario === 'status-flood') {
              await page.evaluate(async () => {
                const path = '/interop.js'
                const fixture: typeof import('./interop-browser.ts') =
                  await import(path)
                return fixture.flood(1200)
              })
              const saturated = await until(readConnector, readonly)
              const browserClosed = await until(readBrowser, readonly)
              expect(['pending-limit', 'message-budget']).toContain(
                reason(saturated),
              )
              expect(saturated).toMatchObject({
                state: { kind: 'readonly' },
                resources: {
                  closeCount: 1,
                  receiveEnabled: false,
                  authTimer: false,
                  lifetimeTimer: false,
                },
              })
              assertBounds(saturated)
              expect(browserClosed).toMatchObject({
                state: { kind: 'readonly' },
                closeCount: 1,
                receiveEnabled: false,
              })
              expect(
                await page.evaluate(async () => {
                  const path = '/interop.js'
                  const fixture: typeof import('./interop-browser.ts') =
                    await import(path)
                  return fixture.flood(1200)
                }),
              ).toBe(0)
              expect(await readConnector()).toEqual(saturated)
              expect(await readBrowser()).toEqual(browserClosed)
            }
            if (scenario === 'closed') {
              await page.evaluate(async () => {
                const path = '/interop.js'
                const fixture: typeof import('./interop-browser.ts') =
                  await import(path)
                fixture.closePeer()
              })
              const connectorClosed = await until(readConnector, readonly)
              const browserClosed = await until(readBrowser, readonly)
              expect(browserClosed).toMatchObject({
                state: { kind: 'readonly' },
                connection: 'closed',
              })
              expect(connectorClosed).toMatchObject({
                state: { kind: 'readonly' },
              })
            }
          } else {
            const connectorResult = await until(readConnector, readonly)
            const browserResult = await until(readBrowser, readonly)
            expect(connectorResult).toMatchObject({
              state: {
                kind: 'readonly',
                ...(scenario === 'timeout'
                  ? { reason: 'deadline' }
                  : scenario.startsWith('tampered-') ||
                      scenario === 'substitution'
                    ? {}
                    : { reason: 'identity-or-transcript' }),
              },
              accepted: [],
            })
            console.info(
              JSON.stringify({
                runtime,
                scenario,
                observation: 'negative',
                connector: connectorResult,
                browser: browserResult,
              }),
            )
            expect(browserResult).toMatchObject({
              state: { kind: 'readonly' },
              accepted: [],
            })
            if (scenario === 'substitution')
              expect([
                reason(connectorResult),
                reason(browserResult),
              ]).toContain('identity-or-transcript')
            if (
              ['wrong-identity', 'substitution', 'replay'].includes(scenario)
            ) {
              expect(connectorResult).toMatchObject({
                fingerprintMatches: true,
              })
              expect(browserResult).toMatchObject({ fingerprintMatches: true })
            }
            if (scenario === 'tampered-offer')
              expect(browserResult).toMatchObject({
                sawDtlsFailure: true,
                accepted: [],
              })
            if (scenario === 'tampered-answer')
              expect(connectorResult).toMatchObject({
                transportStates: expect.arrayContaining(['failed']),
              })
            if (scenario.startsWith('tampered-')) {
              for (const result of [connectorResult, browserResult])
                expect(result).toMatchObject({
                  state: { kind: 'readonly' },
                  accepted: [],
                  rtcProofsSent: 0,
                  rtcProofsReceived: 0,
                  receivedRtc: 0,
                })
              expect(connectorResult).toMatchObject({
                fingerprintMatches: false,
                sent: 0,
              })
              expect(browserResult).toMatchObject({
                fingerprintMatches: false,
                sent: 0,
              })
            }
            const after = await page.evaluate(async () => {
              const path = '/interop.js'
              const fixture: typeof import('./interop-browser.ts') =
                await import(path)
              return fixture.attemptAfterReadonly()
            })
            expect(after.sentStatus).toBe(false)
            expect(await readBrowser()).toMatchObject({
              state: { kind: 'readonly' },
            })
          }
          console.info(
            JSON.stringify({
              runtime,
              scenario,
              elapsedMs: performance.now() - scenarioStarted,
              totalElapsedMs: performance.now() - started,
              connector: await readConnector(),
              browser: await readBrowser(),
            }),
          )
          await child.request({ kind: 'close' })
          await expect(
            child.request({ kind: 'answer', sdp: answer.sdp }),
          ).rejects.toThrow('terminal')
          await page.evaluate(async () => {
            const path = '/interop.js'
            const fixture: typeof import('./interop-browser.ts') = await import(
              path
            )
            fixture.dispose()
          })
        }
        console.info(JSON.stringify({ stage: 'closing-page', runtime }))
        await page.close()
        console.info(JSON.stringify({ stage: 'closed-page', runtime }))
        await child.stop()
        console.info(JSON.stringify({ stage: 'stopped-child', runtime }))
        expect(child.process.exitCode).toBe(0)
        child = undefined
      }
    } finally {
      console.info(JSON.stringify({ stage: 'final-cleanup' }))
      try {
        await child?.stop()
      } finally {
        try {
          console.info(
            JSON.stringify({
              stage: 'closing-browser',
              elapsedMs: performance.now() - started,
            }),
          )
          await browser?.close()
          console.info(
            JSON.stringify({
              stage: 'closed-browser',
              elapsedMs: performance.now() - started,
            }),
          )
        } finally {
          server.closeAllConnections()
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          )
          console.info(JSON.stringify({ stage: 'stopped-server' }))
        }
      }
    }
  },
)
