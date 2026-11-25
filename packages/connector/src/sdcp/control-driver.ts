/**
 * Guarded SDCP print control over one local WebSocket. Reached only through the
 * Connector's signed-command dispatcher: nothing here accepts a wire claim.
 *
 * One command frame per attempt, never retried. The acknowledgement
 * (cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0 @ f977215, "Ack Code")
 * only says the board accepted the request; the outcome is confirmed by the
 * printer's own later status report, never by the send or the acknowledgement.
 */
import WebSocket from 'ws'
import { resinArtifactFormatFor } from '../../../shared/src/print-file/resin-artifacts.ts'
import {
  controlTargetState,
  type ExtendedControlAction,
} from '../../../farm-protocol/src/control-actions.ts'
import {
  readPrinterBinding,
  readSdcpPrinterBinding,
  type PrinterBinding,
} from '../control/printer-binding.ts'
import type {
  ControlObservation,
  PauseDriver,
} from '../control/pause-dispatcher.ts'
import { DriverRefusalError } from '../control/driver-refusal.ts'
import { buildSdcpCommand, sdcpRequest } from './commands.ts'
import { resolveSdcpTarget, type SdcpTarget } from './identity.ts'
import {
  SDCP_CONTROL_ACTIONS,
  sdcpProfile,
  sdcpStartQualified,
  sdcpStartUnavailableMessage,
  RESIN_LIBRARY_START_MESSAGE,
  type SdcpAction,
  type SdcpQualification,
} from './models.ts'
import { decodeSdcpAck, decodeSdcpStatus, type SdcpReport } from './report.ts'

export class SdcpControlTimeout extends Error {
  readonly code = 'SDCP_CONTROL_TIMEOUT'
  constructor() {
    super('SDCP control report timeout')
  }
}

export function openFixedSdcpControl(input: {
  binding: PrinterBinding
  connectionGeneration: number
  clock: { monotonicNow(): number }
  publish(observation: ControlObservation | null): void
  signal: AbortSignal
  timeoutMs?: number
  pollMs?: number
  /** Local composition only; the shipped list is empty. */
  qualifiedStarts?: readonly SdcpQualification[] | undefined
}) {
  const local = readSdcpPrinterBinding(input.binding)
  const mapping = readPrinterBinding(input.binding)
  const profile = local && sdcpProfile(local.model)
  if (!local || !mapping || !profile || input.signal.aborted)
    throw new Error('SDCP control unavailable')
  const timeoutMs = input.timeoutMs ?? 5000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000)
    throw new Error('Invalid SDCP control timeout')
  let target: SdcpTarget | undefined
  let socket: WebSocket | undefined
  let latest: ControlObservation | undefined
  let report: SdcpReport | undefined
  let sequence = 0
  let attempted = false
  let prepared = false
  let stopped = false
  let action: SdcpAction | undefined
  let args: Record<string, unknown> = {}
  let requestId = ''
  let ack: number | undefined
  let sentSequence = 0
  let sentMono = 0
  let poll: ReturnType<typeof setInterval> | undefined
  let notify: (() => void) | undefined
  const controller = new AbortController()
  const failure = () => new Error('SDCP control unavailable')
  function current() {
    if (
      stopped ||
      input.signal.aborted ||
      readSdcpPrinterBinding(input.binding) !== local
    )
      throw failure()
  }
  function stop() {
    if (stopped) return
    stopped = true
    clearTimeout(lifetime)
    clearInterval(poll)
    input.signal.removeEventListener('abort', stop)
    controller.abort()
    socket?.terminate()
    latest = undefined
    input.publish(null)
    notify?.()
  }
  const lifetime = setTimeout(stop, 30000)
  function refresh() {
    if (target && socket?.readyState === WebSocket.OPEN)
      socket.send(
        JSON.stringify(
          sdcpRequest(
            target,
            profile!,
            buildSdcpCommand(target.model, 'status'),
          ).frame,
        ),
      )
  }
  function matches(next: SdcpAction): boolean {
    if (!latest) return false
    if (next === 'start_print')
      return (
        report?.filename === args.file &&
        (latest.printState === 'printing' || latest.printState === 'paused')
      )
    return latest.printState === controlTargetState(next)
  }
  function onMessage(data: WebSocket.RawData, binary: boolean) {
    if (stopped || binary) return
    const raw = data.toString()
    if (requestId) {
      const code = decodeSdcpAck(raw, local!.mainboardId, requestId)
      if (code !== undefined) {
        ack = code
        notify?.()
        return
      }
    }
    const next = decodeSdcpStatus(raw, local!.mainboardId, profile!.family)
    if (!next) return
    report = next
    const now = input.clock.monotonicNow()
    const started =
      action === 'start_print' &&
      attempted &&
      typeof args.file === 'string' &&
      next.filename === args.file &&
      (next.state === 'printing' || next.state === 'paused')
    latest = Object.freeze({
      assignmentId: mapping!.assignment_id,
      printerKey: mapping!.printer_key,
      connectionGeneration: input.connectionGeneration,
      sequence: ++sequence,
      ready: next.state !== 'error',
      printState: next.state,
      readyObservedMono: now,
      printStateObservedMono: now,
      receivedMono: now,
      ...(started
        ? {
            effect: {
              kind: 'file' as const,
              filename: args.file as string,
              observedMono: now,
            },
          }
        : {}),
    })
    input.publish(latest)
    notify?.()
  }
  async function connect() {
    try {
      target = await resolveSdcpTarget(local!, {
        ...(local!.discoveryPort ? { port: local!.discoveryPort } : {}),
        signal: controller.signal,
      })
      if (stopped) return
      socket = new WebSocket(
        `ws://${local!.host}:${local!.websocketPort ?? 3030}/websocket`,
        {
          maxPayload: 65536,
          handshakeTimeout: timeoutMs,
          perMessageDeflate: false,
          followRedirects: false,
        },
      )
      socket.on('error', stop)
      socket.on('close', stop)
      socket.on('message', onMessage)
      socket.on('open', () => {
        refresh()
        poll = setInterval(refresh, input.pollMs ?? 500)
      })
    } catch {
      stop()
    }
  }
  input.signal.addEventListener('abort', stop, { once: true })
  void connect()
  function wait(predicate: () => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        notify = undefined
        reject(new SdcpControlTimeout())
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
  /** Every check and wait that precedes the write guard. Writes no command. */
  async function prewrite(
    next: ExtendedControlAction,
    values: Record<string, unknown>,
    request: Parameters<NonNullable<PauseDriver['execute']>>[2],
  ) {
    current()
    if (
      !prepared ||
      request.binding !== input.binding ||
      request.signal.aborted
    )
      throw new DriverRefusalError('state', 'SDCP control unavailable')
    if (!(SDCP_CONTROL_ACTIONS as readonly string[]).includes(next))
      throw new DriverRefusalError(
        'unsupported-action',
        'SDCP control action unavailable',
      )
    attempted = true
    const fixed = next as SdcpAction
    // The firmware is the one the printer just reported for this session.
    if (
      fixed === 'start_print' &&
      !sdcpStartQualified(
        local!.model,
        target!.firmwareVersion,
        input.qualifiedStarts,
      )
    )
      throw new DriverRefusalError(
        'unsupported-action',
        `SDCP start_print is not qualified for ${local!.model} firmware ${target!.firmwareVersion}`,
        {
          userMessage: sdcpStartUnavailableMessage(
            local!.model,
            target!.firmwareVersion,
          ),
        },
      )
    // Built before the guard: an invalid argument never reaches the printer.
    const command = buildSdcpCommand(local!.model, fixed, values)
    if (fixed === 'start_print') {
      // As on the API path, a resin file starts only as a validated library
      // version: its name cannot show which resin model it was sliced for.
      if (
        resinArtifactFormatFor(String(command.Data.Filename)) &&
        request.verifiedResinFilename !== command.Data.Filename
      )
        throw new DriverRefusalError(
          'invalid-command',
          'resin-artifact-requires-library-version',
          { userMessage: RESIN_LIBRARY_START_MESSAGE },
        )
      // A printer still storing an upload reports a busy machine status; wait
      // for a stopped report instead of sending into it.
      await wait(
        () =>
          latest?.printState === 'idle' || latest?.printState === 'cancelled',
      )
    }
    current()
    return { fixed, ...sdcpRequest(target!, profile!, command) }
  }
  async function send(
    next: ExtendedControlAction,
    values: Record<string, unknown>,
    request: Parameters<NonNullable<PauseDriver['execute']>>[2],
  ): Promise<{ acknowledged: boolean }> {
    // Untyped: after a first attempt, a write may already have happened.
    if (attempted) throw failure()
    const {
      fixed,
      requestId: id,
      frame,
    } = await prewrite(next, values, request).catch((error: unknown) => {
      throw error instanceof DriverRefusalError
        ? error
        : new DriverRefusalError(
            'state',
            error instanceof Error ? error.message : 'SDCP control unavailable',
            {
              cause: error,
              userMessage:
                'A impressora não ficou pronta para receber o comando.',
            },
          )
    })
    action = fixed
    args = values
    // `prewrite` resolved a microtask ago: recheck on the sending stack.
    if (socket?.readyState !== WebSocket.OPEN || request.signal.aborted)
      throw new DriverRefusalError('state', 'SDCP control unavailable')
    if (!request.beforeSend()) throw failure()
    requestId = id
    sentSequence = sequence
    sentMono = input.clock.monotonicNow()
    socket.send(JSON.stringify(frame))
    await wait(() => ack !== undefined)
    if (ack !== 0) throw new Error(`SDCP command refused with Ack ${ack}`)
    refresh()
    await wait(() => sequence > sentSequence && matches(fixed))
    return { acknowledged: true }
  }
  const driver: PauseDriver = {
    execute: (next, values, request) => send(next, values, request),
    pauseOnce: (request) => send(request.action ?? 'pause', {}, request),
    async waitForPaused(request) {
      current()
      if (
        request.binding !== input.binding ||
        request.signal.aborted ||
        !action ||
        (request.action !== undefined && request.action !== action) ||
        !latest ||
        latest.sequence <= request.after.sequence ||
        latest.connectionGeneration !== request.after.connectionGeneration ||
        latest.receivedMono <= request.after.sentMono ||
        latest.receivedMono < sentMono ||
        !matches(action)
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
    async close() {
      stop()
    },
  }
}
