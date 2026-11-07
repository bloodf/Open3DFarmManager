import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomBytes, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { browserBundle } from '../../../tests/helpers/browser-bundle.ts'
import { chromium, type Browser } from '@playwright/test'
import {
  RtcSessionBinding,
  rtcDtlsFingerprint,
  rtcSdpHash,
} from '../../farm-protocol/src/rtc-session-binding.ts'
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function field(value: unknown, key: string) {
  if (!record(value) || typeof value[key] !== 'string')
    throw Error('Missing ' + key)
  return value[key]
}
export class FixtureProcess {
  process: ChildProcessWithoutNullStreams
  #pending:
    | { resolve: (value: unknown) => void; reject: (error: Error) => void }
    | undefined
  stderr = ''
  #exited: Promise<void>
  #closed: Promise<void>
  #ipcError: Error | undefined
  constructor(runtime: string) {
    if (runtime !== process.execPath || process.versions.bun)
      throw Error('Node runtime required')
    this.process = spawn(
      runtime,
      [new URL('./native-media-child.ts', import.meta.url).pathname],
      { stdio: 'pipe' },
    )
    this.process.stdin.on('error', (error) => {
      this.#ipcError = error
      const pending = this.#pending
      this.#pending = undefined
      pending?.reject(error)
      this.process.kill('SIGTERM')
    })
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
    if (this.#ipcError) throw this.#ipcError
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

export async function disposeFiniteResources(
  disposals: readonly (() => unknown | Promise<unknown>)[],
) {
  const results = await Promise.allSettled(
    disposals.map((dispose) => Promise.resolve().then(dispose)),
  )
  const failures = results.filter((result) => result.status === 'rejected')
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason),
      'Finite fixture cleanup failed',
    )
}

export type EncodedFiniteMedia = Readonly<{
  codec: string
  width: number
  height: number
  totalBytes: number
  units: readonly Readonly<{
    data: string
    keyframe: boolean
    timestampUs: number
  }>[]
}>
export type FiniteMediaTransport = Readonly<{
  /** Starts source processes only after BOTH native and browser proof checks. */
  transmit(
    input: Readonly<{
      deadlineMonoMs: number
      signal: AbortSignal
      send(
        unit: Readonly<{
          data: Uint8Array
          keyframe: boolean
          timestampUs: number
        }>,
      ): Promise<boolean>
    }>,
  ): Promise<void>
  dispose(): Promise<void>
}>
export type FiniteMediaOptions = Readonly<{
  /** Encoding preflight only, before native allocation; never starts RTSP PLAY. */
  prepare(encoded: EncodedFiniteMedia): Promise<FiniteMediaTransport>
}>

/** Manual, explicitly gated phase. No production camera, registry or signalling service. */
export async function runFiniteMediaPhase(
  phase: 'encode' | 'native',
  options?: FiniteMediaOptions,
) {
  const entry =
    phase === 'encode'
      ? './moving-h264-source.ts'
      : './browser-media-fixture.ts'
  const fixtureBundle = await browserBundle(
    fileURLToPath(new URL(entry, import.meta.url)),
  )
  const server = createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405)
      res.end()
      return
    }
    if (req.url === '/fixture.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' })
      res.end(fixtureBundle)
      return
    }
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(
        '<!doctype html><html lang="pt-BR"><title>Vídeo finito de teste</title><body>Sem câmera física.</body></html>',
      )
      return
    }
    res.writeHead(404)
    res.end()
  })
  let transport: FiniteMediaTransport | undefined
  const transportAbort = new AbortController()
  let browser: Browser | undefined,
    child: FixtureProcess | undefined,
    timer: ReturnType<typeof setTimeout> | undefined
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string')
      throw Error('Missing fixture port')
    browser = await chromium.launch({ headless: true, timeout: 10000 })
    timer = setTimeout(
      () => {
        void browser?.close()
      },
      phase === 'encode' ? 15000 : 45000,
    )
    console.info(
      JSON.stringify({
        phase,
        node: process.version,
        chromium: browser.version(),
        staticPort: address.port,
        pid: process.pid,
      }),
    )
    const page = await browser.newPage()
    await page.goto('http://127.0.0.1:' + address.port, { timeout: 5000 })
    const encoded = await page.evaluate(async () => {
      const path = '/fixture.js'
      const fixture: typeof import('./moving-h264-source.ts') = await import(
        path
      )
      const result = await fixture.encodeMovingFixture()
      return {
        codec: result.codec,
        width: result.width,
        height: result.height,
        totalBytes: result.totalBytes,
        units: result.units.map((unit) => {
          let binary = ''
          for (let offset = 0; offset < unit.data.length; offset += 4096)
            binary += String.fromCharCode(
              ...unit.data.subarray(offset, offset + 4096),
            )
          return {
            data: btoa(binary),
            keyframe: unit.keyframe,
            timestampUs: unit.timestampUs,
          }
        }),
      }
    })
    assert.equal(encoded.units.length, 30)
    assert.ok(encoded.totalBytes > 0 && encoded.totalBytes <= 4194304)
    for (const [index, unit] of encoded.units.entries()) {
      assert.equal(unit.timestampUs, index * 100000)
      assert.equal(unit.keyframe, true)
      const bytes = Buffer.from(unit.data, 'base64')
      assert.ok(bytes.byteLength > 0 && bytes.byteLength <= 262144)
      assert.ok(
        bytes[0] === 0 &&
          bytes[1] === 0 &&
          (bytes[2] === 1 || (bytes[2] === 0 && bytes[3] === 1)),
        'AnnexB start sequence',
      )
    }
    console.info(
      JSON.stringify({
        stage: 'original-encoding',
        codec: encoded.codec,
        width: encoded.width,
        height: encoded.height,
        units: encoded.units.length,
        totalBytes: encoded.totalBytes,
      }),
    )
    if (phase === 'encode') {
      await page.close()
      return
    }
    transport = await options?.prepare(encoded)
    // Node only in the initial finite-media proof. No native process is started
    // until original fixture encoding above succeeds under the runtime gate.
    child = new FixtureProcess(process.execPath)
    const hello = await child.request({ kind: 'hello' })
    console.info(
      JSON.stringify({
        stage: 'native-hello',
        version: field(hello, 'version'),
        pid: record(hello) ? hello.pid : undefined,
        libdatachannel: field(hello, 'libdatachannel'),
      }),
    )
    const agent = randomUUID()
    const offer = field(await child.request({ kind: 'offer', agent }), 'sdp')
    assert.match(offer, /m=video /)
    assert.match(offer, /a=sendonly/)
    assert.match(offer, /H264\/90000/)
    const browserIdentity = await page.evaluate(async () => {
      const path = '/fixture.js'
      const f: typeof import('./browser-media-fixture.ts') = await import(path)
      return f.identity()
    })
    const answer = await page.evaluate(
      async ({ agent, offer }) => {
        const path = '/fixture.js'
        const f: typeof import('./browser-media-fixture.ts') = await import(
          path
        )
        f.create(agent)
        return f.answer(offer)
      },
      { agent, offer },
    )
    assert.match(answer, /m=video /)
    assert.match(answer, /a=recvonly/)
    const digest = () => randomBytes(32).toString('base64url'),
      now = Date.now()
    const binding = RtcSessionBinding.parse({
      v: 1,
      purpose: 'read-only-rtc',
      transport_id: randomUUID(),
      farm_id: randomUUID(),
      agent_id: agent,
      account_id: 'finite_fixture_account',
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
    await child.request({ kind: 'answer', sdp: answer })
    const before = await child.request({ kind: 'snapshot' })
    assert.ok(
      record(before) && record(before.media) && record(before.media.budget),
    )
    assert.equal(before.media.budget.frames, 0)
    // Parent bound begins BEFORE either peer can activate its independent 5s lease.
    const transportDeadlineMonoMs = performance.now() + 5000
    await child.request({ kind: 'admit', binding })
    await page.evaluate(async (binding) => {
      const path = '/fixture.js'
      const f: typeof import('./browser-media-fixture.ts') = await import(path)
      f.admit(binding)
    }, binding)
    const webRead = () =>
      page.evaluate(async () => {
        const path = '/fixture.js'
        const f: typeof import('./browser-media-fixture.ts') = await import(
          path
        )
        return f.snapshot()
      })
    const observe = async (
      read: () => Promise<unknown>,
      ready: (value: Record<string, unknown>) => boolean,
    ) => {
      const start = performance.now()
      while (performance.now() - start < 8000) {
        const value = await read()
        if (record(value) && ready(value)) return value
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      throw Error(
        'Finite media observation deadline ' + JSON.stringify(await read()),
      )
    }
    const nativeVerified = await observe(
      () => child!.request({ kind: 'snapshot' }),
      (value) =>
        record(value.peer) &&
        value.peer.state === 'verified' &&
        record(value.media) &&
        value.media.trackOpen === true,
    )
    const webVerified = await observe(
      webRead,
      (value) =>
        record(value.peer) &&
        value.peer.state === 'verified' &&
        record(value.video) &&
        value.video.active === true,
    )
    for (const receipt of [nativeVerified, webVerified]) {
      assert.ok(record(receipt.peer))
      assert.equal(receipt.peer.sentProofs, 1)
      assert.equal(receipt.peer.receivedProofs, 1)
      assert.equal(
        receipt.peer.actualRemoteFingerprint,
        receipt.peer.expectedRemoteFingerprint,
      )
      assert.equal(receipt.peer.commands_enabled, false)
    }
    if (transport) {
      await transport.transmit({
        deadlineMonoMs: transportDeadlineMonoMs,
        signal: transportAbort.signal,
        async send(unit) {
          if (
            transportAbort.signal.aborted ||
            performance.now() >= transportDeadlineMonoMs
          )
            return false
          const outcome = await child!.request({
            kind: 'media',
            data: Buffer.from(unit.data).toString('base64'),
            keyframe: unit.keyframe,
            timestampUs: unit.timestampUs,
          })
          return (
            !transportAbort.signal.aborted &&
            performance.now() < transportDeadlineMonoMs &&
            record(outcome) &&
            outcome.sent === true
          )
        },
      })
    } else {
      for (const unit of encoded.units) {
        assert.deepEqual(await child.request({ kind: 'media', ...unit }), {
          sent: true,
        })
        // Source-side finite pacing, deliberately below10fps. No native pacer/queue.
        await new Promise((resolve) => setTimeout(resolve, 110))
      }
    }
    const decoded = await observe(
      webRead,
      (value) =>
        record(value.video) &&
        typeof value.video.framesDecoded === 'number' &&
        value.video.framesDecoded >= (transport ? 30 : 3) &&
        typeof value.video.callbacks === 'number' &&
        value.video.callbacks >= (transport ? 30 : 3),
    )
    assert.ok(record(decoded.video) && Array.isArray(decoded.video.samples))
    if (transport) {
      assert.equal(decoded.video.videoWidth, 128)
      assert.equal(decoded.video.videoHeight, 96)
      assert.ok(
        typeof decoded.video.framesDecoded === 'number' &&
          decoded.video.framesDecoded >= 30,
      )
      assert.ok(
        typeof decoded.video.callbacks === 'number' &&
          decoded.video.callbacks >= 30,
      )
    }
    const centers = new Set<number>()
    for (const sample of decoded.video.samples) {
      assert.ok(record(sample))
      if (
        typeof sample.centerX === 'number' &&
        typeof sample.brightPixels === 'number' &&
        sample.brightPixels >= 180
      )
        centers.add(Math.round(sample.centerX / 4))
    }
    assert.ok(centers.size >= 3, 'Decoded moving pixels required')
    console.info(
      JSON.stringify({
        stage: 'actual-decoded-moving-video',
        video: decoded.video,
      }),
    )
    await child.request({ kind: 'revoke' })
    const stopped = await observe(
      webRead,
      (value) =>
        record(value.peer) &&
        value.peer.state === 'readonly' &&
        record(value.video) &&
        value.video.terminal === true &&
        value.video.attached === false,
    )
    const stoppedNative = await child.request({ kind: 'snapshot' })
    assert.deepEqual(
      await child.request({ kind: 'media', ...encoded.units[0] }),
      { sent: false },
    )
    await new Promise((resolve) => setTimeout(resolve, 350))
    const later = await webRead()
    assert.ok(record(later))
    assert.deepEqual(later.video, stopped.video)
    assert.deepEqual(await child.request({ kind: 'snapshot' }), stoppedNative)
    console.info(
      JSON.stringify({
        stage: 'revoked-no-new-submissions-or-presentations',
        native: stoppedNative,
        video: stopped.video,
      }),
    )
    await page.close()
  } catch (error) {
    if (child)
      console.info(
        JSON.stringify({
          stage: 'finite-failure',
          native: await child
            .request({ kind: 'snapshot' })
            .catch(() => ({ unavailable: true })),
        }),
      )
    throw error
  } finally {
    clearTimeout(timer)
    transportAbort.abort()
    await disposeFiniteResources([
      () => transport?.dispose(),
      () => child?.stop(),
      () => browser?.close(),
      async () => {
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        )
      },
    ])
    console.info(JSON.stringify({ stage: 'finite-resources-closed' }))
  }
}
