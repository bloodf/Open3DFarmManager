import { moonrakerAuthHeaders } from '../config/moonraker.ts'
import { fetchMoonrakerConfigfile } from '../machine-profile/moonraker-fetch.ts'
import {
  ConfigWriteRefused,
  createMoonrakerConfigEditor,
} from './control-config-editor.ts'
import { consumeStagedConfig } from '../runtime/file-upload.ts'
import {
  BedMeshRefused,
  bedMeshQueryWire,
  bedMeshSupported,
  parseBedMeshState,
  refuseBedMesh,
} from './control-bed-mesh.ts'
import {
  ConfigWriteArguments,
  controlTargetState,
  ExcludeObjectArguments,
  controlSourceState,
  U1_CONTROL_RESULT_TIMEOUT_MS,
  type ControlAction,
  type ExtendedControlAction,
} from '../../../farm-protocol/src/control-actions.ts'
import { executePower } from './control-power.ts'
import {
  FileOperationRefused,
  fileOperationAcknowledged,
  prepareFileOperation,
  requireStoppedPrinter,
} from './control-file-manager.ts'
import {
  ExcludeObjectRefusal,
  excludeObjectProbe,
  excludeObjectWire,
} from './control-print-status.ts'
import { buildMoonrakerCommand } from './commands.ts'
import { isDeclaredSnapmakerU1 } from './u1-tools.ts'
import {
  SNAPMAKER_U1_MARKER,
  SnapmakerU1CommandRefused,
  snapmakerU1Controls,
  snapmakerU1ToolHeaters,
} from './u1-marker.ts'
import {
  requireU1HeaterLimit,
  U1ConfigRefusal,
  u1ConfigSettings,
  u1ConsoleAudit,
  u1ConsoleTool,
  u1HomeAudit,
  u1JogAudit,
  u1TemperatureAudit,
  type U1Audit,
} from './u1-audit.ts'
import {
  parseQueueOp,
  parseQueueStatus,
  queueNeedsStatus,
  queueStatusWire,
  QueueRefused,
  queueReplyAccepted,
  queueSupported,
  refuseQueueOp,
} from './control-job-queue.ts'
import {
  checkExtrudeProbe,
  ExtrudeRefused,
  extrudeProbeWire,
  parseExtrude,
} from './control-extrusion.ts'
import { OutputRefused } from './control-outputs.ts'
import {
  parseTimelapseOp,
  parseTimelapseStatus,
  refuseTimelapseOp,
  TimelapseRefused,
  timelapseReplyAccepted,
  timelapseStatusWire,
  timelapseSupported,
} from './control-timelapse.ts'
import { z } from 'zod'
import { decodeMoonrakerFrame } from './frame.ts'
import {
  ConsoleRefusal,
  classifyIdleConsole,
  consoleQueryWire,
  consoleSupported,
  parseConsoleState,
  refuseConsole,
  takeConsoleRate,
} from './control-console.ts'
import {
  MotionRefusal,
  isMotionAction,
  motionNeedsState,
  motionQueryWire,
  motionSupported,
  parseMotionState,
  refuseMotion,
  type MotionAction,
} from './control-motion.ts'
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
// Vendor firmware adds envelope members (Snapmaker U1: `cli_time`, `dev_time`),
// so unknown members are ignored. An error reply is never a success reply.
const Reply = z
  .looseObject({
    jsonrpc: z.literal('2.0'),
    id: z.number().int(),
    result: z.unknown(),
  })
  .refine((reply) => Object.hasOwn(reply, 'result') && !('error' in reply))
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
    exclude_object: z
      .object({ excluded_objects: z.array(z.string()) })
      .optional(),
    webhooks: z.strictObject({
      state: z.enum(['ready', 'startup', 'shutdown', 'error']),
    }),
    print_stats: z.strictObject({
      filename: z.string().optional(),
      total_duration: z.number().finite().nonnegative().optional(),
      info: z.unknown().optional(),
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
const U1AuditSnapshot = Snapshot.extend({
  status: Snapshot.shape.status.loose(),
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
const editors = new WeakMap<
  PrinterBinding,
  ReturnType<typeof createMoonrakerConfigEditor>
>()

export function openFixedMoonrakerPause(input: {
  binding: PrinterBinding
  allowedOrigins: readonly string[]
  limits: MoonrakerLimits
  connectionGeneration: number
  clock: { monotonicNow(): number }
  publish(observation: ControlObservation | null): void
  observeRun?:
    | ((
        evidence: import('../runtime/api-job-lifecycle.ts').ApiRunEvidence,
      ) => void)
    | undefined
  /** Permanent owner/context cancellation, including readonly result auditing. */
  signal: AbortSignal
  /**
   * Locally detected printer.objects.list. Extended actions are built against
   * it and refused without it; lifecycle actions never need it.
   */
  objects?: readonly string[] | undefined
  /** Local admin switch of the G-code console; off unless provisioned. */
  gcodeConsole?: boolean | undefined
}) {
  const candidateMapping = readPrinterBinding(input.binding)
  if (
    !candidateMapping ||
    !Number.isSafeInteger(input.connectionGeneration) ||
    input.connectionGeneration < 0
  )
    throw new Error('Invalid local pause binding')
  const mapping = candidateMapping
  const u1 = isDeclaredSnapmakerU1(mapping.printer_key)
  const u1Controls = u1 ? snapmakerU1Controls(input.objects) : undefined
  const toolHeaters = u1 ? snapmakerU1ToolHeaters(input.objects) : []
  const commandObjects =
    u1 && input.objects && !input.objects.includes(SNAPMAKER_U1_MARKER)
      ? [...input.objects, SNAPMAKER_U1_MARKER]
      : input.objects
  let u1Audit: U1Audit | undefined
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
    audited = false
  let extended: ExtendedControlAction | undefined
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
      if (binary || !Buffer.isBuffer(data)) throw failure()
      const frame = decodeMoonrakerFrame(
        data,
        binary,
        Math.min(4096, selected.limits.maxMessageBytes),
      )
      // Side notifications cannot acknowledge a request; do not count them
      // toward the reply-frame or byte caps while waiting for a result.
      if (SideNotification.safeParse(frame).success) return
      if (++receivedFrames > 16 || (receivedBytes += data.byteLength) > 32768)
        throw failure()
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
    withFilename = false,
    excludedName?: string,
  ): Promise<ControlObservation> {
    try {
      const started = now()
      const id = index === 0 ? 1 : index + 2
      const readRun = index === 0 && input.observeRun !== undefined
      const audit = index > 0 ? u1Audit : undefined
      const wire =
        excludedName !== undefined
          ? excludeObjectProbe(id)
          : withFilename || readRun || audit
            ? JSON.stringify({
                jsonrpc: '2.0',
                id,
                method: 'printer.objects.query',
                params: {
                  objects: {
                    webhooks: ['state'],
                    print_stats: readRun
                      ? ['state', 'filename', 'total_duration', 'info']
                      : withFilename
                        ? ['state', 'filename']
                        : ['state'],
                    ...audit?.objects,
                  },
                },
              })
            : QUERIES[index]
      if (!wire) throw failure()
      const result = await request(id, wire, deadline)
      const snapshot = (audit ? U1AuditSnapshot : Snapshot).parse(result)
      const received = now()
      current()
      if (received >= deadline || snapshot.eventtime <= sourceTime)
        throw failure()
      sourceTime = snapshot.eventtime
      const state = snapshot.status.print_stats.state
      const auditEffect =
        state !== 'error' && audit?.effect(snapshot.status, started)
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
        ...(toolHeaters.length ? { toolHeaters } : {}),
        ...(auditEffect ? { effect: auditEffect } : {}),
        ...(withFilename && snapshot.status.print_stats.filename !== undefined
          ? {
              effect: {
                kind: 'file' as const,
                filename: snapshot.status.print_stats.filename,
                observedMono: started,
              },
            }
          : {}),
        ...(excludedName &&
        snapshot.status.exclude_object?.excluded_objects.includes(excludedName)
          ? {
              effect: {
                kind: 'excluded-object' as const,
                name: excludedName,
                observedMono: started,
              },
            }
          : {}),
      })
      if (readRun)
        input.observeRun?.({
          filename: snapshot.status.print_stats.filename,
          duration: snapshot.status.print_stats.total_duration,
          info: snapshot.status.print_stats.info,
          sourceTime: snapshot.eventtime,
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
    accepts: (result: unknown) => boolean = (result) => result === 'ok',
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
      operationDeadline = Math.min(
        lifetimeDeadline,
        started + Math.max(5000, cap ?? 0),
      )
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
        if (now() >= operationDeadline || !accepts(result)) throw failure()
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
    if (!commandObjects) return undefined
    try {
      const call = buildMoonrakerCommand(action, args, commandObjects)
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
  async function readU1Settings(signal: AbortSignal) {
    // Installed config can exceed the fixed command socket's reply ceiling.
    const result = await fetchMoonrakerConfigfile({
      origin: selected.origin,
      limits: selected.limits,
      signal: AbortSignal.any([ownerSignal, signal]),
    }).catch(() => undefined)
    return u1ConfigSettings(result)
  }
  /**
   * Motion: refusals are decided from one toolhead read before the single
   * send. A refused action closes the attempt having written nothing.
   */
  async function executeMotion(
    action: MotionAction,
    args: Record<string, unknown>,
    requested: Parameters<PauseDriver['pauseOnce']>[0],
  ) {
    try {
      if (
        requested.binding !== binding ||
        !prepared ||
        attempted ||
        !motionSupported(input.objects)
      )
        throw new MotionRefusal('unsupported')
      // Same builder as the send; it also rejects malformed arguments.
      const wire = extendedWire(action, args)
      if (wire === undefined) throw new MotionRefusal('invalid')
      if (motionNeedsState(action)) {
        const state = parseMotionState(
          await request(11, motionQueryWire(11), lifetimeDeadline),
        )
        refuseMotion(action, args, state)
        if (u1 && action === 'jog')
          u1Audit = u1JogAudit(
            args,
            state,
            await readU1Settings(requested.signal),
          )
      }
      return await send(wire, requested, 5000)
    } catch (error) {
      stop()
      await closed
      if (u1 && error instanceof U1ConfigRefusal) throw error
      if (u1 && error instanceof MotionRefusal)
        throw Object.assign(error, {
          refusal:
            error.code === 'invalid'
              ? 'invalid-command'
              : error.code === 'unsupported'
                ? 'unsupported-action'
                : 'state',
        })
      throw error instanceof MotionRefusal ? error : failure()
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
    extended = 'extrude'
    return send(extendedWire('extrude', args), request, 5000)
  }
  /**
   * Queue operation: refusals are decided from one read of the queue before
   * the single send. A refused operation closes the attempt having written
   * nothing, and an uncertain send is never repeated.
   */
  async function queueOp(
    args: Record<string, unknown>,
    requested: Parameters<PauseDriver['pauseOnce']>[0],
  ) {
    try {
      if (
        requested.binding !== binding ||
        !prepared ||
        attempted ||
        !queueSupported(input.objects)
      )
        throw new QueueRefused('unsupported-action')
      const { op } = parseQueueOp(args)
      const wire = extendedWire('queue_op', args)
      if (wire === undefined) throw new QueueRefused('invalid-command')
      refuseQueueOp(
        op,
        queueNeedsStatus(op)
          ? parseQueueStatus(await requestRead(11, queueStatusWire(11)))
          : undefined,
      )
      extended = 'queue_op'
      return await send(
        wire,
        requested,
        5000,
        (result) => result === 'ok' || queueReplyAccepted(result),
      )
    } catch (error) {
      stop()
      await closed
      throw error instanceof QueueRefused ? error : failure()
    }
  }
  /**
   * Timelapse render or delete: refusals are decided from one read before the
   * single send; a refusal writes nothing and an uncertain send never repeats.
   */
  async function timelapse(
    args: Record<string, unknown>,
    requested: Parameters<PauseDriver['pauseOnce']>[0],
  ) {
    try {
      if (
        requested.binding !== binding ||
        !prepared ||
        attempted ||
        !timelapseSupported(input.objects)
      )
        throw new TimelapseRefused('unsupported-action')
      const { op } = parseTimelapseOp(args)
      const wire = extendedWire('timelapse', args)
      if (wire === undefined) throw new TimelapseRefused('invalid-command')
      refuseTimelapseOp(
        op,
        parseTimelapseStatus(
          op,
          await requestRead(11, timelapseStatusWire(11, op)),
        ),
      )
      extended = 'timelapse'
      return await send(wire, requested, 5000, (result) =>
        timelapseReplyAccepted(op, result),
      )
    } catch (error) {
      stop()
      await closed
      throw error instanceof TimelapseRefused ? error : failure()
    }
  }
  /**
   * Named fans, LEDs and pins: the name is checked against the object list
   * before the single write; a refusal sends nothing and is never retried.
   */
  async function output(
    action: ExtendedControlAction,
    args: Record<string, unknown>,
    request: Parameters<PauseDriver['pauseOnce']>[0],
  ) {
    if (!input.objects || request.binding !== binding || !prepared || attempted)
      throw new OutputRefused('invalid-command')
    try {
      buildMoonrakerCommand(action, args, input.objects)
    } catch (error) {
      stop()
      await closed
      throw error instanceof OutputRefused
        ? error
        : new OutputRefused('invalid-command')
    }
    extended = action
    return send(extendedWire(action, args), request, 5000)
  }
  let excludedName: string | undefined
  async function excludeObject(
    args: Record<string, unknown>,
    requested: Parameters<PauseDriver['pauseOnce']>[0],
  ) {
    let wire: string
    try {
      if (
        requested.binding !== binding ||
        !prepared ||
        attempted ||
        !input.objects?.includes('exclude_object') ||
        !input.objects.includes('print_stats')
      )
        throw new ExcludeObjectRefusal(
          'Object exclusion unavailable',
          'unsupported-action',
        )
      const parsed = ExcludeObjectArguments.safeParse(args)
      if (!parsed.success)
        throw new ExcludeObjectRefusal(
          'Invalid print object name',
          'invalid-command',
        )
      wire = excludeObjectWire(
        parsed.data,
        await requestRead(11, excludeObjectProbe(11)),
      )
      excludedName = parsed.data.name
    } catch (error) {
      stop()
      await closed
      throw error instanceof ExcludeObjectRefusal
        ? error
        : new ExcludeObjectRefusal('Print object state unavailable')
    }
    extended = 'exclude_object'
    return send(wire, requested, 5000)
  }
  /**
   * Bed mesh: refusals are decided from one read of the print, homing and
   * profile state before the single send; a refusal writes nothing.
   */
  async function bedMesh(
    args: Record<string, unknown>,
    requested: Parameters<PauseDriver['pauseOnce']>[0],
  ) {
    try {
      if (requested.binding !== binding || !prepared || attempted)
        throw new BedMeshRefused('state')
      if (!bedMeshSupported(input.objects))
        throw new BedMeshRefused('unsupported-action')
      // Same builder as the send; it also rejects malformed arguments.
      const wire = extendedWire('bed_mesh', args)
      if (wire === undefined) throw new BedMeshRefused('invalid-command')
      refuseBedMesh(
        args,
        parseBedMeshState(
          await request(11, bedMeshQueryWire(11), lifetimeDeadline),
        ),
      )
      extended = 'bed_mesh'
      return await send(wire, requested, 5000)
    } catch (error) {
      stop()
      await closed
      throw error instanceof BedMeshRefused ? error : failure()
    }
  }
  /**
   * G-code console: switch, support, state and rate refusals all precede the
   * single write; a refusal closes the attempt having sent nothing.
   */
  async function executeConsole(
    args: Record<string, unknown>,
    requested: Parameters<PauseDriver['pauseOnce']>[0],
  ) {
    try {
      if (!input.gcodeConsole) throw new ConsoleRefusal('disabled')
      if (
        requested.binding !== binding ||
        !prepared ||
        attempted ||
        !consoleSupported(input.objects)
      )
        throw new ConsoleRefusal('unsupported')
      const consoleState = parseConsoleState(
        await request(11, consoleQueryWire(11), lifetimeDeadline),
      )
      const line = refuseConsole(
        args,
        consoleState,
        u1
          ? ['SDCARD_PRINT_FILE_WITH_PARAMETERS', 'SDCARD_PRINT_PL_RESTORE']
          : undefined,
      )
      const active =
        consoleState.printState === 'printing' ||
        consoleState.printState === 'paused'
      let wireArgs = args
      let cap = 5000
      let tool: string | undefined
      if (!active) {
        const classification = classifyIdleConsole(line)
        if (classification.kind === 'home') {
          // Canonical homing runs through the structured `home` action, with
          // the U1's own X/Y pairing and Z-only checks.
          const { axes } = classification
          if (u1 && axes.includes('x') !== axes.includes('y'))
            throw new ConsoleRefusal('not-allowed')
          takeConsoleRate(binding, input.clock.monotonicNow())
          if (u1) return await executeU1Home({ axes }, requested, line.trim())
          extended = 'gcode'
          return await send(extendedWire('home', { axes }), requested, 5000)
        }
        const command = line.trim().split(/\s+/)[0]!.toUpperCase()
        // Only the U1's recognised tool selection has a guarded path; every
        // other macro or unclassified line, and any raw motion, is refused.
        tool =
          u1 && classification.kind === 'tool'
            ? u1ConsoleTool(line.trim(), input.objects)
            : undefined
        if (
          !tool &&
          (classification.kind === 'unknown' ||
            classification.kind === 'tool' ||
            classification.kind === 'move' ||
            input.objects?.some(
              (object) => object.toUpperCase() === `GCODE_MACRO ${command}`,
            ))
        )
          throw new ConsoleRefusal('not-allowed')
        if (tool) {
          const state = parseMotionState(
            await request(12, motionQueryWire(12), lifetimeDeadline),
          )
          if (!state.ready || state.printState === 'error')
            throw new ConsoleRefusal('unknown-state')
          if (state.printState === 'printing' || state.printState === 'paused')
            throw new ConsoleRefusal('not-allowed')
          if (!['x', 'y', 'z'].every((axis) => state.homedAxes.includes(axis)))
            throw new ConsoleRefusal('unknown-state')
          // A0 selects the named physical tool without the current job's remap.
          wireArgs = { line: `${line.trim().toUpperCase()} A0` }
          cap = U1_CONTROL_RESULT_TIMEOUT_MS
        }
      }
      if (u1) u1Audit = u1ConsoleAudit(line.trim(), tool)
      const wire = extendedWire('gcode', wireArgs)
      if (wire === undefined) throw new ConsoleRefusal('invalid')
      takeConsoleRate(binding, input.clock.monotonicNow())
      extended = 'gcode'
      return await send(wire, requested, cap)
    } catch (error) {
      stop()
      await closed
      if (error instanceof MotionRefusal || error instanceof U1ConfigRefusal)
        throw new ConsoleRefusal('unknown-state')
      throw error instanceof ConsoleRefusal ? error : failure()
    }
  }
  const requestRead = (id: number, wire: string) =>
    request(id, wire, lifetimeDeadline)
  async function executeU1Heater(
    action: 'set_temperature' | 'set_tool_temperature',
    args: Record<string, unknown>,
    requested: Parameters<PauseDriver['pauseOnce']>[0],
  ) {
    const wire = extendedWire(action, args)
    if (wire === undefined)
      throw Object.assign(Error('Invalid U1 heater arguments'), {
        refusal: 'invalid-command',
      })
    const audit = u1TemperatureAudit(action, args)
    if (audit.target !== 0)
      requireU1HeaterLimit(
        await readU1Settings(requested.signal),
        audit.heater,
        audit.target,
      )
    extended = action
    u1Audit = audit
    return send(wire, requested, 5000)
  }
  async function executeU1Home(
    args: Record<string, unknown>,
    requested: Parameters<PauseDriver['pauseOnce']>[0],
    consoleLine?: string,
  ) {
    const wire = extendedWire('home', args)
    if (wire === undefined)
      throw Object.assign(Error('Invalid U1 home arguments'), {
        refusal: 'invalid-command',
      })
    const audit = u1HomeAudit(args)
    if (audit.zOnly) {
      const state = await request(11, motionQueryWire(11), lifetimeDeadline)
        .then(parseMotionState)
        .catch(() => undefined)
      if (
        !state?.ready ||
        !['standby', 'complete', 'cancelled'].includes(state.printState) ||
        !state.homedAxes.includes('x') ||
        !state.homedAxes.includes('y')
      )
        throw new U1ConfigRefusal('U1 Z homing requires homed X and Y axes')
    }
    // A console line is confirmed as the signed `gcode` action, not as `home`.
    extended = consoleLine ? 'gcode' : 'home'
    u1Audit = consoleLine ? u1ConsoleAudit(consoleLine) : audit
    return send(wire, requested, U1_CONTROL_RESULT_TIMEOUT_MS)
  }
  async function configWrite(
    args: Record<string, unknown>,
    request: Parameters<NonNullable<PauseDriver['execute']>>[2],
  ) {
    const parsed = ConfigWriteArguments.safeParse(args)
    const { stillAuthorized } = request
    if (
      !parsed.success ||
      !request.transportId ||
      !stillAuthorized ||
      request.binding !== binding ||
      !prepared ||
      attempted ||
      !input.objects?.includes('configfile') ||
      !input.objects.includes('print_stats')
    )
      throw Object.assign(Error('Invalid config command'), {
        refusal: 'invalid-command',
      })
    let editor = editors.get(binding)
    if (!editor) {
      editor = createMoonrakerConfigEditor(
        selected.origin,
        moonrakerAuthHeaders(selected.origin, selected.limits)['X-Api-Key'],
      )
      editors.set(binding, editor)
    }
    current()
    attempted = true
    const config = parsed.data
    const options = {
      ...config,
      signal: AbortSignal.any([request.signal, ownerSignal]),
      authorize() {
        current()
        return stillAuthorized()
      },
      beforeWrite: request.beforeSend,
    }
    try {
      if ('backup' in config)
        await editor.restore({ ...options, backup: config.backup })
      else {
        const content = consumeStagedConfig(
          request.transportId,
          config.path,
          config.sha256,
        )
        if (!content) throw new ConfigWriteRefused('invalid')
        await editor.write({ ...options, sha256: config.sha256, content })
      }
      current()
      now()
      return { acknowledged: true }
    } catch (error) {
      if (error instanceof ConfigWriteRefused)
        throw Object.assign(error, {
          refusal: error.reason === 'state' ? 'state' : 'invalid-command',
        })
      throw error
    }
  }

  const driver: PauseDriver = Object.freeze({
    execute(
      action: ExtendedControlAction,
      args: Record<string, unknown>,
      request: Parameters<NonNullable<PauseDriver['execute']>>[2],
    ) {
      if (u1 && !u1Controls?.includes(action))
        return Promise.reject(new SnapmakerU1CommandRefused(action))
      if (action === 'pause' || action === 'resume' || action === 'cancel')
        return send(commandWire(action), request)
      if (isMotionAction(action)) {
        extended = action
        return executeMotion(action, args, request)
      }
      if (action === 'file_op' || action === 'start_print') {
        if (!input.objects?.includes('virtual_sdcard'))
          throw new FileOperationRefused('unsupported-action')
        extended = action
        const read = (method: string, params: object) =>
          requestRead(
            11,
            JSON.stringify({ jsonrpc: '2.0', id: 11, method, params }),
          )
        if (action === 'start_print')
          return requireStoppedPrinter(read).then(() =>
            send(extendedWire(action, args), request, 5000),
          )
        return prepareFileOperation(args, read).then((call) =>
          send(
            JSON.stringify({ jsonrpc: '2.0', id: 2, ...call }),
            request,
            5000,
            (result) => fileOperationAcknowledged(result, args),
          ),
        )
      }
      if (action === 'config_write') return configWrite(args, request)
      if (action === 'exclude_object') return excludeObject(args, request)
      if (action === 'bed_mesh') return bedMesh(args, request)
      if (action === 'gcode') return executeConsole(args, request)
      if (
        u1 &&
        (action === 'set_temperature' || action === 'set_tool_temperature')
      )
        return executeU1Heater(action, args, request)
      if (u1 && action === 'home') return executeU1Home(args, request)
      if (action === 'extrude') return extrude(args, request)
      if (action === 'power') {
        extended = 'power'
        return executePower(
          args,
          input.objects ?? [],
          request,
          requestRead,
          send,
          async () => {
            stop()
            await closed
          },
        )
      }
      if (action === 'queue_op') return queueOp(args, request)
      if (action === 'timelapse') return timelapse(args, request)
      if (action === 'set_fan' || action === 'set_led' || action === 'set_pin')
        return output(action, args, request)
      extended = action
      return send(extendedWire(action, args), request, 5000)
    },
    pauseOnce(request: Parameters<PauseDriver['pauseOnce']>[0]) {
      if (u1 && !u1Controls?.includes(request.action ?? 'pause'))
        return Promise.reject(
          new SnapmakerU1CommandRefused(request.action ?? 'pause'),
        )
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
          const observation = await query(
            1,
            operationDeadline,
            extended === 'start_print',
            excludedName,
          )
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
        // A restart drops the state read-back. The acknowledged restart
        // request stands, reported as unconfirmed, which does not lock the
        // printer; throwing here would hold every later command as busy.
        if (extended === 'service') return null
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
