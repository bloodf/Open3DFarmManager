import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { chromium, type Browser, type Page } from '@playwright/test'
import { z } from 'zod'
import { BrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import { ControlSessionBinding, controlSdpHash, controlDtlsFingerprint, controlBindingHash, decodeControlProof, verifyControlSessionProof } from '../../packages/farm-protocol/src/control-session-binding.ts'
import { PauseChannelFrame, MAX_PAUSE_CHANNEL_WIRE_BYTES, encodePauseChannelFrame } from '../../packages/farm-protocol/src/pause-channel.ts'
import { encodePauseCapability, signPauseCapability, MAX_PAUSE_CAPABILITY_WIRE_BYTES } from '../../packages/farm-protocol/src/pause-capability.ts'
import type { PausePhaseMessage } from '../../packages/connector/src/webrtc/pause-control-session.ts'

export const pauseControlRtcScenarios = ['valid', 'wrong-assignment', 'wrong-proof', 'deadline', 'oversize'] as const
export type PauseControlRtcScenario = (typeof pauseControlRtcScenarios)[number]
const Snapshot = z.object({
  diagnostics: z.object({ proofsReady: z.boolean(), sentProofs: z.number().int(), receivedProofs: z.number().int(), terminal: z.boolean(), commandsEnabled: z.literal(false), pending: z.number().int(), retainedBytes: z.number().int(), certificateMatched: z.boolean(), closeCount: z.number().int(), cleanupFailures: z.number().int() }),
  ready: z.object({ binding: ControlSessionBinding, deadlineMonoMs: z.number(), browserProofWire: z.string().max(8192), connectorProofWire: z.string().max(8192) }).optional(),
  phases: z.array(PauseChannelFrame).max(2), terminals: z.number().int(), settled: z.boolean(), reason: z.string().optional(),
})
type Snapshot = z.infer<typeof Snapshot>
async function bounded<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(label + ' deadline')), ms) })]) }
  finally { clearTimeout(timer) }
}
class ConnectorChild {
  readonly child: ChildProcessWithoutNullStreams
  readonly closed: Promise<void>
  #pending: { resolve(value: unknown): void; reject(error: Error): void } | undefined
  #carry = Buffer.alloc(0)
  #stderr = 0
  #closed = false
  constructor() {
    this.child = spawn(process.execPath, [new URL('./pause-control-rtc-child.ts', import.meta.url).pathname], { stdio: 'pipe' })
    const child = this.child
    this.closed = new Promise((resolve) => child.once('close', (code, signal) => {
      this.#closed = true
      this.fail(Error('Connector child closed'))
      console.info(JSON.stringify({ event: 'pause-child-close', pid: child.pid, code, signal, stdoutDrained: child.stdout.readableEnded, stderrDrained: child.stderr.readableEnded }))
      resolve()
    }))
    child.once('exit', (code, signal) => {
      this.fail(Error('Connector child exit'))
      console.info(JSON.stringify({ event: 'pause-child-exit', pid: child.pid, code, signal }))
    })
    child.on('error', (error) => this.fail(error))
    child.stdin.on('error', (error) => this.fail(error))
    child.stdout.on('error', (error) => this.fail(error))
    child.stderr.on('error', (error) => this.fail(error))
    child.stderr.on('data', (chunk: Buffer) => {
      this.#stderr += chunk.length
      if (this.#stderr > 65536) { this.fail(Error('Child stderr bound')); child.kill('SIGTERM') }
    })
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.#carry.length + chunk.length > 65536) { this.fail(Error('Child stdout bound')); child.kill('SIGTERM'); return }
      this.#carry = Buffer.concat([this.#carry, chunk])
      const end = this.#carry.indexOf(10)
      if (end < 0) return
      const pending = this.#pending
      this.#pending = undefined
      if (!pending || end !== this.#carry.length - 1) { pending?.reject(Error('Unsolicited child output')); child.kill('SIGTERM'); return }
      const line = this.#carry.subarray(0, end); this.#carry = Buffer.alloc(0)
      try {
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line))
        if (value && typeof value === 'object' && 'error' in value) throw Error('Child command rejected')
        pending.resolve(value)
      } catch { pending.reject(Error('Invalid child response')) }
    })
  }
  private fail(error: Error) { const pending = this.#pending; this.#pending = undefined; pending?.reject(error) }
  async request(input: unknown) {
    if (this.#pending || this.#closed || this.child.exitCode !== null || this.child.signalCode !== null) throw Error('Child request lifecycle')
    const wire = JSON.stringify(input) + '\n'
    if (Buffer.byteLength(wire) > 65536) throw Error('Child request byte limit')
    try {
      return await bounded(new Promise<unknown>((resolve, reject) => {
        this.#pending = { resolve, reject }
        this.child.stdin.write(wire, (error) => { if (error) this.fail(error) })
      }), 9000, 'Child IPC')
    } finally { this.#pending = undefined }
  }
  async stop() {
    if (!this.#closed) {
      this.child.stdin.end()
      try { await bounded(this.closed, 3000, 'Child graceful close') }
      catch { this.child.kill('SIGKILL'); await bounded(this.closed, 1000, 'Child killed close') }
    }
    assert.equal(this.#carry.length, 0)
    assert.equal(this.child.stdout.readableEnded, true)
    assert.equal(this.child.stderr.readableEnded, true)
    assert.equal(this.child.exitCode, 0, 'Child must exit normally; forced cleanup is not acceptance')
  }
}
type BrowserCommand =
  | { kind: 'initialize' | 'snapshot' | 'close' }
  | { kind: 'create'; expected: unknown; wrongProof: boolean }
  | { kind: 'answer'; sdp: string }
  | { kind: 'admit'; binding: unknown }
  | { kind: 'send'; message: PausePhaseMessage }
async function browserCall(page: Page, input: BrowserCommand) {
  return bounded(page.evaluate(async (value) => {
    const path = '/fixture.js'
    const fixture: typeof import('./pause-control-rtc-browser.ts') = await import(path)
    switch (value.kind) {
      case 'initialize': return fixture.initialize()
      case 'snapshot': return fixture.snapshot()
      case 'close': return fixture.close()
      case 'create': return fixture.create(value.expected, value.wrongProof)
      case 'answer': return fixture.answer(value.sdp)
      case 'admit': return fixture.admit(value.binding)
      case 'send': return fixture.send(value.message)
    }
  }, input), 9000, 'Browser fixture')
}
async function observe(read: () => Promise<unknown>, predicate: (value: Snapshot) => boolean, label: string, ms = 9000) {
  const deadline = performance.now() + ms
  while (performance.now() < deadline) {
    const value = Snapshot.parse(await read())
    if (predicate(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw Error(label + ' observation deadline')
}
function assertClosed(value: Snapshot) {
  assert.equal(value.diagnostics.terminal, true)
  assert.equal(value.diagnostics.closeCount, 1)
  assert.equal(value.diagnostics.cleanupFailures, 0)
  assert.equal(value.diagnostics.pending, 0)
  assert.equal(value.diagnostics.retainedBytes, 0)
  assert.equal(value.diagnostics.commandsEnabled, false)
  assert.equal(value.terminals, 1)
  assert.equal(value.settled, true)
}
