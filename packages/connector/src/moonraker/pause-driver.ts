import {
  controlTargetState,
  controlSourceState,
  type ControlAction,
  type ExtendedControlAction,
} from '../../../farm-protocol/src/control-actions.ts'
import { buildMoonrakerCommand } from './commands.ts'
import {
  checkExtrudeProbe,
  ExtrudeRefused,
  extrudeProbeWire,
  parseExtrude,
} from './control-extrusion.ts'
import { z } from 'zod'
import { decodeMoonrakerFrame } from './frame.ts'
import {
  readPrinterBinding,
  type PrinterBinding,
} from '../control/printer-binding.ts'
import type {
  ControlObservation,
  PauseDriver,
} from '../control/pause-dispatcher.ts'
import {
  validateMoonrakerInput,
  type MoonrakerLimits,
} from '../config/moonraker.ts'

// Same approved ws transport and addon policy as the maintained readonly client.
process.env.WS_NO_BUFFER_UTIL = '1'
process.env.WS_NO_UTF_8_VALIDATE = '1'
const { default: WebSocket } = await import('ws')
const Reply = z.strictObject({
  jsonrpc: z.literal('2.0'),
  id: z.number().int(),
  result: z.unknown(),
})
// Moonraker broadcasts these while PAUSE runs. They carry no command or
// freshness authority; only a matching reply and complete query may do that.
const SideNotification = z.strictObject({
  jsonrpc: z.literal('2.0'),
  // Unrequested printer-state and Klippy lifecycle messages remain terminal.
  // Other bounded notifications cannot acknowledge a request or refresh state.
  method: z
    .string()
    .max(128)
    .regex(/^notify_(?!status_update$|klippy_)[A-Za-z0-9_]+$/),
  params: z.array(z.unknown()).max(16),
})
const Snapshot = z.strictObject({
  eventtime: z.number().finite().nonnegative(),
  status: z.strictObject({
    webhooks: z.strictObject({
      state: z.enum(['ready', 'startup', 'shutdown', 'error']),
    }),
    print_stats: z.strictObject({
      state: z.enum([
        'standby',
        'printing',
        'paused',
        'error',
        'complete',
        'cancelled',
      ]),
    }),
  }),
})
const commandWire = (action: ControlAction) =>
  JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: {
      pause: 'printer.print.pause',
      resume: 'printer.print.resume',
      cancel: 'printer.print.cancel',
    }[action],
  })
const queryWire = (id: number) =>
  JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'printer.objects.query',
    params: { objects: { webhooks: ['state'], print_stats: ['state'] } },
  })
const QUERIES = [1, 3, 4, 5, 6, 7, 8, 9, 10].map(queryWire)

/** One locally bound connection/attempt. This supplies no capability or RTC authority.
 * API contract pin: Moonraker 71f9e677b81afcc6b99dd5002f595025c38edc7b (v0.9.3).
 */
export function openFixedMoonrakerPause(input: {
  binding: PrinterBinding
  allowedOrigins: readonly string[]
  limits: MoonrakerLimits
  connectionGeneration: number
  clock: { monotonicNow(): number }
  publish(observation: ControlObservation | null): void
  /** Permanent owner/context cancellation, including readonly result auditing. */
  signal: AbortSignal
  /**
   * Locally detected printer.objects.list. Extended actions are built against
   * it and refused without it; lifecycle actions never need it.
   */
  objects?: readonly string[] | undefined
}) {
  const candidateMapping = readPrinterBinding(input.binding)
  if (
    !candidateMapping ||
    !Number.isSafeInteger(input.connectionGeneration) ||
    input.connectionGeneration < 0
  )
    throw new Error('Invalid local pause binding')
  const mapping = candidateMapping
  const selected = validateMoonrakerInput({
    assignment: {
      printerKey: mapping.printer_key,
      origin: mapping.moonraker_origin,
    },
    allowedOrigins: input.allowedOrigins,
    limits: input.limits,
  })
  const ownerSignal = input.signal
  const binding = input.binding,
    generation = input.connectionGeneration
  const mono = input.clock.monotonicNow.bind(input.clock)
  const publish = input.publish.bind(input)
  let previous = mono()
  if (
    !Number.isFinite(previous) ||
    previous < 0 ||
    previous > Number.MAX_SAFE_INTEGER - 30000
  )
    throw new Error('Invalid local pause clock')
  const lifetimeDeadline = previous + 30000,
    prepareDeadline = previous + 8000
  let terminal = false,
    prepared = false,
    attempted = false,
    acknowledged = false,
    audited = false,
    extended = false
  let sequence = 0,
    sourceTime = -1,
    receivedBytes = 0,
    receivedFrames = 0
  let operationDeadline = lifetimeDeadline
  let operationTimer: ReturnType<typeof setTimeout> | undefined
  let commandSignal: AbortSignal | undefined
  let pending:
    | {
        id: number
        resolve(value: unknown): void
        reject(error: Error): void
        timer: ReturnType<typeof setTimeout>
      }
    | undefined
  let resolveOpen: () => void = () => {},
    rejectOpen: (error: Error) => void = () => {},
    resolveClosed: () => void = () => {}
  const opened = new Promise<void>((resolve, reject) => {
    resolveOpen = resolve
    rejectOpen = reject
  })
  void opened.catch(() => {})
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  const url = new URL('/websocket', selected.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(url, {
    maxPayload: Math.min(4096, selected.limits.maxMessageBytes),
    maxFragments: 32,
    maxBufferedChunks: 32,
    perMessageDeflate: false,
    followRedirects: false,
    autoPong: false,
    handshakeTimeout: Math.min(5000, selected.limits.connectTimeoutMs),
    skipUTF8Validation: false,
  })
  function failure() {
    return new Error('Local pause connection unavailable')
  }
  function detachCommand() {
    commandSignal?.removeEventListener('abort', commandAbort)
    commandSignal = undefined
  }
  function stop() {
    if (terminal) return
    terminal = true
    clearTimeout(operationTimer)
    clearTimeout(lifetimeTimer)
    clearTimeout(preparationTimer)
    ownerSignal.removeEventListener('abort', ownerAbort)
    detachCommand()
    rejectOpen(failure())
    if (pending) {
      clearTimeout(pending.timer)
      const old = pending
      pending = undefined
      old.reject(failure())
    }
    try {
      publish(null)
    } catch {
      /* Invalidation cannot resurrect a terminal socket. */
    }
    socket.terminate()
  }
  function ownerAbort() {
    stop()
  }
  function commandAbort() {
    stop()
  }
  function now(): number {
    if (terminal) throw failure()
    let value: number
    try {
      value = mono()
    } catch {
      stop()
      throw failure()
    }
    if (
      !Number.isFinite(value) ||
      value < previous ||
      value >= lifetimeDeadline
    ) {
      stop()
      throw failure()
    }
    previous = value
    return value
  }
  function current() {
    if (
      terminal ||
      ownerSignal.aborted ||
      commandSignal?.aborted ||
      readPrinterBinding(binding) !== mapping ||
      socket.readyState !== WebSocket.OPEN
    )
      throw failure()
  }
  function readyToWrite() {
    current()
    if (pending || socket.bufferedAmount !== 0) throw failure()
  }
  const lifetimeTimer = setTimeout(stop, 30000)
  const preparationTimer = setTimeout(
    stop,
    Math.min(
      8000,
      selected.limits.connectTimeoutMs + selected.limits.requestTimeoutMs,
    ),
  )
  socket.on('open', () => {
    if (!terminal) resolveOpen()
  })
  socket.on('error', stop)
  socket.on('ping', stop)
  socket.on('pong', stop)
  socket.on('close', () => {
    stop()
    socket.off('error', stop)
    socket.off('ping', stop)
    socket.off('pong', stop)
    resolveClosed()
  })
  socket.on('message', (data, binary) => {
    if (terminal) return
    try {
      current()
      if (
        binary ||
        !Buffer.isBuffer(data) ||
        ++receivedFrames > 16 ||
        (receivedBytes += data.byteLength) > 32768
      )
        throw failure()
      const frame = decodeMoonrakerFrame(
        data,
        binary,
        Math.min(4096, selected.limits.maxMessageBytes),
      )
      if (SideNotification.safeParse(frame).success) return
      const result = Reply.parse(frame)
      if (
        !pending ||
        result.id !== pending.id ||
        !Object.hasOwn(result, 'result')
      )
        throw failure()
      const request = pending
      pending = undefined
      clearTimeout(request.timer)
      request.resolve(result.result)
    } catch {
      stop()
    }
  })
  ownerSignal.addEventListener('abort', ownerAbort, { once: true })
  if (ownerSignal.aborted) stop()
  function request(
    id: number,
    wire: string,
    deadline: number,
    guard?: () => boolean,
    cap = Math.min(1000, selected.limits.requestTimeoutMs),
  ): Promise<unknown> {
    try {
      const sampled = now()
      readyToWrite()
      // A G-code script replies only once Klipper finished it, so the single
      // extended request may use the whole operation window.
      const remaining = Math.min(cap, deadline - sampled)
      if (remaining <= 0) throw failure()
      const promise = new Promise<unknown>((resolve, reject) => {
        pending = { id, resolve, reject, timer: setTimeout(stop, remaining) }
      })
      void promise.catch(() => {})
      // The request slot and bytes are prepared before the guard. Nothing awaits, samples
      // a clock, publishes observations or calls user code between true and native send.
      if (guard && guard() !== true) {
        stop()
        return promise
      }
      socket.send(wire, { binary: false, compress: false }, (error) => {
        if (error) stop()
      })
      return promise
    } catch {
      stop()
      return Promise.reject(failure())
    }
  }
  async function query(
    index: number,
    deadline: number,
  ): Promise<ControlObservation> {
    try {
      const started = now()
      const id = index === 0 ? 1 : index + 2
      const wire = QUERIES[index]
      if (!wire) throw failure()
      const snapshot = Snapshot.parse(await request(id, wire, deadline))
      const received = now()
      current()
      if (received >= deadline || snapshot.eventtime <= sourceTime)
        throw failure()
      sourceTime = snapshot.eventtime
      const state = snapshot.status.print_stats.state
      const observation: ControlObservation = Object.freeze({
        assignmentId: mapping.assignment_id,
        printerKey: mapping.printer_key,
        connectionGeneration: generation,
        sequence: ++sequence,
        ready: snapshot.status.webhooks.state === 'ready',
        printState:
          state === 'printing' ||
          state === 'paused' ||
          state === 'cancelled' ||
          state === 'error'
            ? state
            : 'idle',
        readyObservedMono: started,
        printStateObservedMono: started,
        receivedMono: received,
      })
      publish(observation)
      current()
      return observation
    } catch {
      stop()
      await closed
      throw failure()
    }
  }
  let preparing = false
  async function prepare(): Promise<void> {
    if (preparing || prepared || terminal) throw failure()
    preparing = true
    try {
      await opened
      if (now() >= prepareDeadline) throw failure()
      await query(0, prepareDeadline)
      prepared = true
      clearTimeout(preparationTimer)
    } catch {
      stop()
      await closed
      throw failure()
    }
  }
  /** The single command of this attempt; `wire` is always built locally. */
  function send(
    wire: string | undefined,
    {
      binding: requested,
      beforeSend,
      signal,
    }: Parameters<PauseDriver['pauseOnce']>[0],
    cap?: number,
  ) {
    if (
      requested !== binding ||
      !prepared ||
      attempted ||
      terminal ||
      wire === undefined
    ) {
      stop()
      return closed.then(() => {
        throw failure()
      })
    }
    attempted = true
    commandSignal = signal
    signal.addEventListener('abort', commandAbort, { once: true })
    if (signal.aborted) stop()
    try {
      const started = now()
      operationDeadline = Math.min(lifetimeDeadline, started + 5000)
      operationTimer = setTimeout(stop, operationDeadline - started)
    } catch {
      stop()
      return closed.then(() => {
        throw failure()
      })
    }
    return request(
      2,
      wire,
      operationDeadline,
      beforeSend,
      cap ?? selected.limits.requestTimeoutMs,
    )
      .then((result) => {
        current()
        if (now() >= operationDeadline || result !== 'ok') throw failure()
        current()
        acknowledged = true
        return { acknowledged: true }
      })
      .catch(async () => {
        stop()
        await closed
        throw failure()
      })
  }
  function extendedWire(
    action: ExtendedControlAction,
    args: Record<string, unknown>,
  ): string | undefined {
    if (!input.objects) return undefined
    try {
      const call = buildMoonrakerCommand(action, args, input.objects)
      return JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: call.method,
        ...(call.params ? { params: call.params } : {}),
      })
    } catch {
      return undefined
    }
  }
  /**
   * Cold-extrusion guard: one read-only query of the live tool, then the
   * single command. Every refusal happens before a write and is never retried.
   */
  async function extrude(
    args: Record<string, unknown>,
    request: Parameters<PauseDriver['pauseOnce']>[0],
  ) {
    if (!input.objects || request.binding !== binding || !prepared || attempted)
      throw new ExtrudeRefused('state')
    const { name } = parseExtrude(args, input.objects)
    try {
      checkExtrudeProbe(await requestRead(11, extrudeProbeWire(11, name)), name)
    } catch (error) {
      stop()
      await closed
      throw error instanceof ExtrudeRefused
        ? error
        : new ExtrudeRefused('state')
    }
    extended = true
    return send(extendedWire('extrude', args), request, 5000)
  }
  const requestRead = (id: number, wire: string) =>
    request(id, wire, lifetimeDeadline)
  const driver: PauseDriver = Object.freeze({
    execute(
      action: ExtendedControlAction,
      args: Record<string, unknown>,
      request: Parameters<PauseDriver['pauseOnce']>[0],
    ) {
      if (action === 'pause' || action === 'resume' || action === 'cancel')
        return send(commandWire(action), request)
      if (action === 'extrude') return extrude(args, request)
      extended = true
      return send(extendedWire(action, args), request, 5000)
    },
    pauseOnce(request: Parameters<PauseDriver['pauseOnce']>[0]) {
      return send(commandWire(request.action ?? 'pause'), request)
    },
    async waitForPaused({
      action = 'pause',
      binding: requested,
      after,
      signal,
    }: Parameters<PauseDriver['waitForPaused']>[0]) {
      try {
        current()
        if (
          requested !== binding ||
          !acknowledged ||
          audited ||
          signal !== commandSignal ||
          signal.aborted ||
          after.connectionGeneration !== generation ||
          after.sequence !== 1 ||
          !Number.isFinite(after.sentMono)
        )
          throw failure()
        audited = true
        if (extended) {
          // No print-state target exists for an extended action. Report the
          // first state read after the acknowledged request and let the
          // dispatcher judge it.
          const observation = await query(1, operationDeadline)
          detachCommand()
          return observation
        }
        for (let i = 1; i <= 8; i++) {
          const observation = await query(i, operationDeadline)
          if (
            observation.ready &&
            observation.printState === controlTargetState(action) &&
            observation.readyObservedMono > after.sentMono &&
            observation.printStateObservedMono > after.sentMono
          ) {
            // Dispatcher aborts its per-command work before the final pure audit. Native
            // liveness and permanent owner cancellation stay active through that audit.
            detachCommand()
            return observation
          }
          if (
            !observation.ready ||
            !controlSourceState(action, observation.printState)
          )
            throw failure()
        }
        throw failure()
      } catch {
        stop()
        await closed
        throw failure()
      }
    },
  })
  return Object.freeze({
    prepare,
    driver,
    closed,
    close: () => {
      stop()
      return closed
    },
  })
}
