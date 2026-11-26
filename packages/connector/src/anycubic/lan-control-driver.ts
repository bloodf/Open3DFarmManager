// Control for the models of `models.ts`, reachable only through a qualified
// model and firmware pair. Their `info/report` says `free`/`busy` with the job
// in `project` and the targets in `temp`, and nothing pushes a job's phase, so
// this asks with `info/query` (a read) until the printer shows the result.
// Sources: docs/fullfarmmanager/evidence/anycubic-fdm-models.md (H1, K1).
// No command is ever sent twice.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import {
  controlTargetState,
  type ExtendedControlAction,
} from '../../../farm-protocol/src/control-actions.ts'
import { parseBoundedJson } from '../../../farm-protocol/src/json.ts'
import { readKobraClientCertMaterial } from '../config/kobra-x-cert.ts'
import { readPrivateJsonFile } from '../config/local.ts'
import { DriverRefusalError } from '../control/driver-refusal.ts'
import type {
  ControlObservation,
  PauseDriver,
} from '../control/pause-dispatcher.ts'
import {
  readAnycubicPrinterBinding,
  readPrinterBinding,
  type PrinterBinding,
} from '../control/printer-binding.ts'
import {
  buildAnycubicControlCommand,
  anycubicControls,
} from './control-support.ts'
import { createAnycubicControlTransport } from './control-transport.ts'
import {
  ANYCUBIC_QUALIFIED_WRITES,
  anycubicUnqualifiedMessage,
  type AnycubicQualification,
} from './models.ts'
import { decodeAnycubicReport } from './report.ts'

const POLL_MS = 500
const LIMIT = 131072

const number = z.number().finite().optional().catch(undefined)
const Info = z.object({
  type: z.literal('info'),
  data: z.object({
    version: z.string().min(1).max(64),
    fan_speed_pct: number,
    temp: z
      .object({ target_nozzle_temp: number, target_hotbed_temp: number })
      .optional()
      .catch(undefined),
  }),
})
const Lamp = z.object({ type: z.number(), status: z.number() })
const Light = z.object({
  type: z.literal('light'),
  state: z.string().optional(),
  data: z.union([z.object({ lights: z.array(z.unknown()) }), Lamp]),
})
const CHAMBER_LIGHT = 2

function query(type: 'info' | 'light') {
  return {
    type,
    action: 'query',
    timestamp: Date.now(),
    msgid: randomUUID(),
    data: null,
  }
}

function localBinding(binding: PrinterBinding) {
  const local = readAnycubicPrinterBinding(binding)
  if (!local) throw new Error('Anycubic control unavailable')
  return local
}

/** One short-lived authenticated connection that reads one printer. */
function openReader(input: {
  binding: PrinterBinding
  signal: AbortSignal
  onClosed(): void
  onConnected(): void
  onReport(kind: 'info' | 'light', payload: Buffer, value: unknown): void
}) {
  const local = localBinding(input.binding)
  const clientCert = local.clientCertFile
    ? readKobraClientCertMaterial(local.clientCertFile)
    : undefined
  if (clientCert && !clientCert.ok)
    throw new Error('Anycubic control unavailable')
  const serial = `${local.modelId}/${local.deviceId}`
  const prefix = `anycubic/anycubicCloud/v1/printer/public/${serial}/`
  return createAnycubicControlTransport({
    host: local.host,
    port: local.port,
    serial,
    credentials: {
      username: local.username,
      password: z
        .string()
        .min(1)
        .max(2048)
        .parse(readPrivateJsonFile(local.passwordFile, { maxBytes: 4096 })),
    },
    ...(local.caFile ? { caPem: readFileSync(local.caFile, 'utf8') } : {}),
    ...(local.pinSha256 ? { pinSha256: local.pinSha256 } : {}),
    ...(clientCert?.ok
      ? {
          certPem: clientCert.cert.certificatePem,
          keyPem: clientCert.cert.keyPem,
        }
      : {}),
    limits: {
      maxFrameBytes: LIMIT,
      connectTimeoutMs: 5000,
      maxInflight: 16,
      reconnectDelayMs: 1000,
      maxReconnects: 0,
    },
    signal: input.signal,
    onConnection(state) {
      if (state === 'connected') input.onConnected()
      else input.onClosed()
    },
    onReport(payload, topic) {
      const kind =
        topic === `${prefix}info/report`
          ? 'info'
          : topic === `${prefix}light/report`
            ? 'light'
            : undefined
      if (!kind) return
      try {
        input.onReport(
          kind,
          payload,
          parseBoundedJson(payload.toString('utf8'), {
            maxBytes: LIMIT,
            maxDepth: 16,
            maxValues: 8192,
            maxStringChars: 16384,
          }),
        )
      } catch {
        // A malformed report is no evidence.
      }
    },
  })
}

/** The firmware the bound printer reports now. Publishes only `info/query`. */
export async function readAnycubicFirmware(
  binding: PrinterBinding,
  signal?: AbortSignal,
): Promise<string> {
  const controller = new AbortController()
  const done = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(5000),
    ...(signal ? [signal] : []),
  ])
  const found = Promise.withResolvers<string>()
  const abort = () => found.reject(new Error('Anycubic control unavailable'))
  done.addEventListener('abort', abort, { once: true })
  const transport = openReader({
    binding,
    signal: done,
    onClosed: abort,
    onConnected() {
      void transport.publishWeb(query('info'), () => !done.aborted).catch(abort)
    },
    onReport(kind, _payload, value) {
      const info = kind === 'info' ? Info.safeParse(value) : undefined
      if (info?.success) found.resolve(info.data.data.version)
    },
  })
  try {
    if (done.aborted) abort()
    return await found.promise
  } finally {
    done.removeEventListener('abort', abort)
    controller.abort()
    await transport.close()
  }
}

export function openQualifiedAnycubicControl(input: {
  binding: PrinterBinding
  connectionGeneration: number
  clock: { monotonicNow(): number }
  publish(observation: ControlObservation | null): void
  signal: AbortSignal
  timeoutMs?: number
  /** Replaces the shipped list, which is empty. Tests only. */
  anycubicQualifiedWrites?: readonly AnycubicQualification[] | undefined
}) {
  const local = localBinding(input.binding)
  const mapping = readPrinterBinding(input.binding)
  const qualified = input.anycubicQualifiedWrites ?? ANYCUBIC_QUALIFIED_WRITES
  const firmwares = qualified
    .filter((pair) => pair.modelId === local.modelId)
    .map((pair) => pair.firmwareVersion)
  if (
    !mapping ||
    input.signal.aborted ||
    !firmwares.some(
      (firmware) =>
        anycubicControls(local.modelId, firmware, qualified).length > 0,
    )
  )
    throw new DriverRefusalError(
      'unsupported-action',
      'Anycubic control unavailable',
      { userMessage: anycubicUnqualifiedMessage(local.modelId) },
    )
  const timeoutMs = input.timeoutMs ?? 5000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000)
    throw new Error('Invalid Anycubic control timeout')
  let latest: ControlObservation | undefined
  let firmware: string | undefined
  let sequence = 0
  let attempted = false
  let prepared = false
  let stopped = false
  let action: ExtendedControlAction | undefined
  let actionArgs: Record<string, unknown> = {}
  let sentSequence = 0
  let sentMono = 0
  let lamp: { on: boolean; observedMono: number } | undefined
  let notify: (() => void) | undefined
  let poll: ReturnType<typeof setInterval> | undefined
  const controller = new AbortController()
  const failure = () => new Error('Anycubic control unavailable')
  function stop() {
    if (stopped) return
    stopped = true
    clearInterval(poll)
    clearTimeout(lifetime)
    input.signal.removeEventListener('abort', stop)
    controller.abort()
    latest = undefined
    input.publish(null)
    notify?.()
  }
  function current() {
    if (
      stopped ||
      input.signal.aborted ||
      readAnycubicPrinterBinding(input.binding) !== local
    )
      throw failure()
  }
  const lifetime = setTimeout(stop, 30000)

  /** The printer's own value for the one requested setting, if it matches. */
  function reportedEffect(
    data: z.infer<typeof Info>['data'],
    observedMono: number,
  ): ControlObservation['effect'] {
    if (!attempted) return
    if (action === 'set_temperature') {
      const heater = actionArgs.heater
      if (heater !== 'extruder' && heater !== 'bed') return
      const target =
        heater === 'extruder'
          ? data.temp?.target_nozzle_temp
          : data.temp?.target_hotbed_temp
      return target === actionArgs.target_c
        ? { kind: 'temperature', heater, target_c: target!, observedMono }
        : undefined
    }
    if (action === 'set_fan')
      return data.fan_speed_pct === actionArgs.percent
        ? {
            kind: 'fan',
            fan: 'part',
            percent: data.fan_speed_pct!,
            observedMono,
          }
        : undefined
    if (action === 'set_light')
      return lamp && lamp.on === actionArgs.on && lamp.observedMono > sentMono
        ? { kind: 'light', on: lamp.on, observedMono: lamp.observedMono }
        : undefined
    return
  }

  function ask(type: 'info' | 'light') {
    void transport.publishWeb(query(type), () => !stopped).catch(() => stop())
  }

  const transport = openReader({
    binding: input.binding,
    signal: controller.signal,
    onClosed: stop,
    onConnected() {
      ask('info')
      poll = setInterval(() => {
        if (attempted && action === 'set_light') ask('light')
        ask('info')
      }, POLL_MS)
    },
    onReport(kind, payload, value) {
      if (stopped) return
      const now = input.clock.monotonicNow()
      if (kind === 'light') {
        const report = Light.safeParse(value)
        if (!report.success || report.data.state === 'failed') return
        const found =
          'lights' in report.data.data
            ? report.data.data.lights
                .map((entry) => Lamp.safeParse(entry))
                .find((entry) => entry.data?.type === CHAMBER_LIGHT)?.data
            : report.data.data
        if (
          found?.type === CHAMBER_LIGHT &&
          (found.status === 0 || found.status === 1)
        )
          lamp = { on: found.status === 1, observedMono: now }
        return
      }
      const info = Info.safeParse(value)
      if (!info.success) return
      firmware = info.data.data.version
      // Another firmware is another printer as far as qualification goes.
      if (!firmwares.includes(firmware)) {
        stop()
        return
      }
      const decoded = decodeAnycubicReport(payload, local.modelId)
      const state = 'state' in decoded ? decoded.state : undefined
      if (
        state !== 'printing' &&
        state !== 'paused' &&
        state !== 'idle' &&
        state !== 'finished'
      )
        return
      const effect = reportedEffect(info.data.data, now)
      latest = Object.freeze({
        assignmentId: mapping.assignment_id,
        printerKey: mapping.printer_key,
        connectionGeneration: input.connectionGeneration,
        sequence: ++sequence,
        ready: true,
        printState:
          state === 'printing' || state === 'paused'
            ? state
            : action === 'cancel' && attempted
              ? 'cancelled'
              : 'idle',
        readyObservedMono: now,
        printStateObservedMono: now,
        receivedMono: now,
        ...(effect ? { effect } : {}),
      })
      input.publish(latest)
      notify?.()
    },
  })
  input.signal.addEventListener('abort', stop, { once: true })
  if (input.signal.aborted) stop()

  function wait(predicate: () => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        notify = undefined
        reject(
          Object.assign(new Error('Anycubic control report timeout'), {
            code: 'BAMBU_CONTROL_TIMEOUT',
          }),
        )
      }, timeoutMs)
      const check = () => {
        if (!stopped && !predicate()) return
        clearTimeout(timer)
        notify = undefined
        if (stopped) reject(failure())
        else resolve()
      }
      notify = check
      check()
    })
  }
  const lifecycle = (next: ExtendedControlAction) =>
    next === 'pause' || next === 'resume' || next === 'cancel'

  async function send(
    next: ExtendedControlAction,
    args: Record<string, unknown>,
    request: Parameters<PauseDriver['pauseOnce']>[0],
  ): Promise<{ acknowledged: boolean }> {
    current()
    if (
      !prepared ||
      attempted ||
      !latest ||
      request.binding !== input.binding ||
      request.signal.aborted
    )
      throw failure()
    // Everything below up to the publish refuses without writing.
    if (!anycubicControls(local.modelId, firmware, qualified).includes(next))
      throw new DriverRefusalError(
        'unsupported-action',
        'Anycubic control unavailable',
      )
    // Temperature and fan are job settings (`print/update`).
    if (
      (next === 'set_temperature' || next === 'set_fan') &&
      latest.printState !== 'printing' &&
      latest.printState !== 'paused'
    )
      throw new DriverRefusalError('state', 'Anycubic printer has no job', {
        userMessage:
          'Esta impressora só aceita esse ajuste durante uma impressão.',
      })
    let payload: ReturnType<typeof buildAnycubicControlCommand>
    try {
      payload = buildAnycubicControlCommand(next, args, local.modelId)
    } catch {
      throw new DriverRefusalError(
        'invalid-command',
        'Anycubic control unavailable',
      )
    }
    attempted = true
    action = next
    actionArgs = args
    sentSequence = sequence
    sentMono = input.clock.monotonicNow()
    await transport.publishWeb(payload, () => {
      current()
      return !request.signal.aborted && request.beforeSend()
    })
    await wait(
      () =>
        !!latest &&
        latest.sequence > sentSequence &&
        (lifecycle(next)
          ? latest.printState === controlTargetState(next)
          : latest.effect !== undefined),
    )
    return { acknowledged: true }
  }

  const driver: PauseDriver = {
    execute: (next, args, request) => send(next, args, request),
    pauseOnce: (request) => send(request.action ?? 'pause', {}, request),
    async waitForPaused(request) {
      current()
      if (
        request.binding !== input.binding ||
        request.signal.aborted ||
        (request.action !== undefined && request.action !== action) ||
        !latest ||
        latest.sequence <= request.after.sequence ||
        latest.connectionGeneration !== request.after.connectionGeneration ||
        latest.receivedMono <= request.after.sentMono ||
        latest.receivedMono < sentMono
      )
        return null
      return latest
    },
  }
  return {
    driver,
    async prepare() {
      current()
      if (prepared) throw failure()
      await wait(() => !!latest)
      current()
      prepared = true
    },
    close() {
      stop()
      return transport.close()
    },
  }
}
