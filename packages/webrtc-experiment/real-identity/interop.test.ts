import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomBytes, randomUUID } from 'node:crypto'
import { chromium, type Browser, type Page } from '@playwright/test'
import {
  RtcSessionBinding,
  rtcDtlsFingerprint,
  rtcSdpHash,
  verifyExpectedRtcProof,
} from '../../farm-protocol/src/rtc-session-binding.ts'
function record(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}
function field(v: unknown, key: string) {
  if (!record(v) || typeof v[key] !== 'string') throw Error('Missing ' + key)
  return v[key]
}
class FixtureProcess {
  process: ChildProcessWithoutNullStreams
  #pending:
    | { resolve: (value: unknown) => void; reject: (error: Error) => void }
    | undefined
  stderr = ''
  #exited: Promise<void>
  #closed: Promise<void>
  constructor(runtime: string) {
    this.process = spawn(
      runtime,
      [new URL('./child.ts', import.meta.url).pathname],
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
    this.#closed = new Promise((resolve) => {
      this.process.once('close', (code, signal) => {
        console.info(
          JSON.stringify({
            event: 'fixture-close',
            pid: this.process.pid,
            code,
            signal,
            stdoutDrained: this.process.stdout.readableEnded,
            stderrDrained: this.process.stderr.readableEnded,
          }),
        )
        resolve()
      })
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
    if (this.process.exitCode !== null || this.process.signalCode !== null) {
      await this.#closed
      return
    }
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
    await Promise.race([
      this.#closed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Error('Fixture stdio close deadline')),
          1000,
        )
      }),
    ]).finally(() => clearTimeout(timer))
  }
}

async function browserCall(
  page: Page,
  kind: 'snapshot' | 'status' | 'close' | 'admit',
  binding?: unknown,
) {
  return page.evaluate(
    async ({ kind, binding }) => {
      const path = '/fixture.js'
      const fixture: typeof import('./browser-fixture.ts') = await import(path)
      switch (kind) {
        case 'snapshot':
          return fixture.snapshot()
        case 'status':
          return fixture.status()
        case 'close':
          return fixture.close()
        case 'admit':
          return fixture.admit(binding)
      }
    },
    { kind, binding },
  )
}
async function until(
  read: () => Promise<unknown>,
  state: string,
  deadline = 11000,
) {
  const start = performance.now()
  while (performance.now() - start < deadline) {
    const value = await read()
    if (record(value) && value.state === state) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw Error(
    'Observation deadline ' + state + ' ' + JSON.stringify(await read()),
  )
}
function tamper(sdp: string) {
  const changed = sdp.replace(
    /a=fingerprint:sha-256 [0-9A-Fa-f:]+/,
    'a=fingerprint:sha-256 ' + Array(32).fill('00').join(':'),
  )
  assert.notEqual(changed, sdp)
  return changed
}
test(
  'real P256 browser and encapsulated Ed25519 Connector prove the exact readonly RTC binding',
  { timeout: 120000 },
  async () => {
    const built = spawnSync(
      'bun',
      [
        'build',
        new URL('./browser-fixture.ts', import.meta.url).pathname,
        '--target=browser',
      ],
      { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 },
    )
    assert.equal(built.status, 0, built.stderr)
    const server = createServer((req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405)
        res.end()
        return
      }
      if (req.url === '/fixture.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript' })
        res.end(built.stdout)
        return
      }
      if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(
          '<!doctype html><html lang="pt-BR"><title>Identidade RTC experimental</title><body>Somente dados de teste.</body></html>',
        )
        return
      }
      res.writeHead(404)
      res.end()
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw Error('No server port')
    let browser: Browser | undefined, child: FixtureProcess | undefined
    try {
      browser = await chromium.launch({ headless: true })
      console.info(
        JSON.stringify({
          driver: process.version,
          chromium: browser.version(),
          staticPort: address.port,
        }),
      )
      for (const runtime of process.env.REAL_RTC_RUNTIME === 'node' ||
      process.env.REAL_RTC_RUNTIME === 'bun'
        ? [process.env.REAL_RTC_RUNTIME]
        : ['node', 'bun']) {
        child = new FixtureProcess(runtime)
        const hello = await child.request({ kind: 'hello' })
        console.info(JSON.stringify({ runtime, hello }))
        const page = await browser.newPage()
        try {
          await page.goto('http://127.0.0.1:' + address.port)
          const browserIdentity = await page.evaluate(async () => {
            const path = '/fixture.js'
            const f: typeof import('./browser-fixture.ts') = await import(path)
            return f.identity()
          })
          const scenarios =
            process.env.REAL_RTC_PROBE === 'valid'
              ? ['valid']
              : [
                  'valid',
                  'altered-farm',
                  'wrong-identity',
                  'tampered-offer',
                  'tampered-answer',
                  'admission-timeout',
                  'abandoned-offer',
                  'replay',
                  'preauth-status',
                  'closed',
                ]
          let priorBinding: RtcSessionBinding | undefined
          for (const scenario of scenarios) {
            const agent = randomUUID()
            const offer = field(
              await child.request({ kind: 'offer', agent }),
              'sdp',
            )
            if (scenario === 'abandoned-offer') {
              const expired = await until(
                () => child!.request({ kind: 'snapshot' }),
                'readonly',
              )
              await child.request({ kind: 'admit', binding: {} })
              await new Promise((resolve) => setTimeout(resolve, 30))
              assert.deepEqual(
                await child.request({ kind: 'snapshot' }),
                expired,
              )
              assert.equal(expired.closeCount, 1)
              assert.equal(expired.connection, 'closed')
              console.info(
                JSON.stringify({ runtime, scenario, native: expired }),
              )
              continue
            }
            let replay = ''
            if (scenario === 'replay') {
              assert.ok(priorBinding)
              replay = await page.evaluate(async (binding) => {
                const path = '/fixture.js'
                const f: typeof import('./browser-fixture.ts') = await import(
                  path
                )
                return f.replayWire(binding)
              }, priorBinding)
              assert.equal(
                await verifyExpectedRtcProof(priorBinding, 'browser', replay),
                true,
              )
            }
            const attack =
              scenario === 'replay' || scenario === 'preauth-status'
            const answer = attack
              ? await page.evaluate(
                  async ({ offer, scenario, replay }) => {
                    const path = '/fixture.js'
                    const f: typeof import('./browser-fixture.ts') =
                      await import(path)
                    return f.attackAnswer(
                      offer,
                      scenario === 'replay' ? 'replay' : 'preauth-status',
                      replay,
                    )
                  },
                  { offer, scenario, replay },
                )
              : await page.evaluate(
                  async ({ agent, offer }) => {
                    const path = '/fixture.js'
                    const f: typeof import('./browser-fixture.ts') =
                      await import(path)
                    f.create(agent)
                    return f.answer(offer)
                  },
                  {
                    agent,
                    offer:
                      scenario === 'tampered-offer' ? tamper(offer) : offer,
                  },
                )
            const digest = () => randomBytes(32).toString('base64url')
            const now = Date.now()
            const binding = RtcSessionBinding.parse({
              v: 1,
              purpose: 'read-only-rtc',
              transport_id: randomUUID(),
              farm_id: randomUUID(),
              agent_id: agent,
              account_id: 'synthetic_account',
              key_id: randomUUID(),
              browser_public_key: browserIdentity.publicKey,
              browser_thumbprint: browserIdentity.thumbprint,
              connector_public_key_spki: field(hello, 'spki'),
              connector_fingerprint: field(hello, 'fingerprint'),
              credential_jti: randomUUID(),
              origin: 'https://farm.example',
              audience: 'open3dfarmmanager:connector',
              browser_nonce: digest(),
              connector_nonce: digest(),
              issued_at: now,
              expires_at: now + 30000,
              commands_enabled: false,
              offer_sha256: await rtcSdpHash(offer),
              answer_sha256: await rtcSdpHash(answer),
              browser_dtls: rtcDtlsFingerprint(answer),
              connector_dtls: rtcDtlsFingerprint(offer),
            })
            await child.request({
              kind: 'answer',
              sdp: scenario === 'tampered-answer' ? tamper(answer) : answer,
            })
            if (scenario !== 'admission-timeout') {
              await child.request({ kind: 'admit', binding })
              if (!attack)
                await browserCall(
                  page,
                  'admit',
                  scenario === 'altered-farm'
                    ? { ...binding, farm_id: randomUUID() }
                    : scenario === 'wrong-identity'
                      ? {
                          ...binding,
                          connector_fingerprint: 'SHA256:' + digest(),
                        }
                      : binding,
                )
            }
            if (scenario === 'valid' || scenario === 'closed') {
              const native = await until(
                () => child!.request({ kind: 'snapshot' }),
                'verified',
              )
              const web = await until(
                () => browserCall(page, 'snapshot'),
                'verified',
              )
              assert.equal(
                native.actualRemoteFingerprint,
                native.expectedRemoteFingerprint,
              )
              assert.equal(
                web.actualRemoteFingerprint,
                web.expectedRemoteFingerprint,
              )
              assert.equal(native.sentProofs, 1)
              assert.equal(web.sentProofs, 1)
              assert.equal(native.commands_enabled, false)
              assert.equal(web.commands_enabled, false)
              if (scenario === 'valid') {
                priorBinding = binding
                assert.deepEqual(await child.request({ kind: 'status' }), {
                  sent: true,
                })
                assert.equal(await browserCall(page, 'status'), true)
                const accepted = async (read: () => Promise<unknown>) => {
                  for (let i = 0; i < 100; i++) {
                    const value = await read()
                    if (
                      record(value) &&
                      Array.isArray(value.accepted) &&
                      value.accepted.length === 1
                    )
                      return value
                    await new Promise((r) => setTimeout(r, 20))
                  }
                  throw Error('No actual RTC status')
                }
                assert.deepEqual(
                  (await accepted(() => child!.request({ kind: 'snapshot' })))
                    .accepted,
                  ['fixture-idle'],
                )
                assert.deepEqual(
                  (await accepted(() => browserCall(page, 'snapshot')))
                    .accepted,
                  ['fixture-idle'],
                )
              }
              await child.request({ kind: 'close' })
              await until(() => browserCall(page, 'snapshot'), 'readonly')
            } else {
              const native = await until(
                () => child!.request({ kind: 'snapshot' }),
                'readonly',
              )
              const web = await until(
                () => browserCall(page, 'snapshot'),
                'readonly',
              )
              assert.deepEqual(native.accepted, [])
              assert.deepEqual(web.accepted, [])
              if (scenario === 'replay')
                assert.equal(native.reason, 'identity-or-binding')
              if (scenario === 'preauth-status')
                assert.ok(
                  native.reason === 'application-frame' ||
                    native.terminal === 'application-before-proof',
                )
              if (scenario === 'altered-farm')
                assert.ok(
                  native.reason === 'identity-or-binding' ||
                    web.reason === 'identity-or-binding',
                )
              if (scenario === 'wrong-identity')
                assert.ok(
                  native.reason === 'identity-or-binding' ||
                    web.reason === 'identity-or-binding' ||
                    web.reason === 'local-proof',
                )

              if (scenario.startsWith('tampered-')) {
                assert.equal(native.sentProofs, 0)
                assert.equal(web.sentProofs, 0)
                assert.equal(native.receivedProofs, 0)
                assert.equal(web.receivedProofs, 0)
              }
            }
            const native = await child.request({ kind: 'snapshot' }),
              web = await browserCall(page, 'snapshot')
            console.info(JSON.stringify({ runtime, scenario, native, web }))
            await browserCall(page, 'close')
            await child.request({ kind: 'close' })
          }
        } catch (error) {
          console.info(
            JSON.stringify({
              stage: 'failure-census',
              runtime,
              native: await child.request({ kind: 'snapshot' }),
              web: await browserCall(page, 'snapshot'),
            }),
          )
          throw error
        } finally {
          await page.close()
        }
        await child.stop()
        child = undefined
      }
    } finally {
      await child?.stop()
      await browser?.close()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
      console.info(JSON.stringify({ stage: 'all-resources-closed' }))
    }
  },
)
