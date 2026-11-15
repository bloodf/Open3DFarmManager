import {
  readKobraLinkPrinterBinding,
  readPrinterBinding,
  type PrinterBinding,
} from '../control/printer-binding.ts'
import type {
  PauseDriver,
  ControlObservation,
} from '../control/pause-dispatcher.ts'
import { createKobraLinkClient, type KobraLinkFetch } from './client.ts'
import { readKobraLinkCredential } from './runtime.ts'
import { KobraLinkExtendedCommand } from './extended-control.ts'

/** How long a sent lifecycle action waits for the bridge to report its target state. */
const CONFIRM_WAIT_MS = 4000
const CONFIRM_POLL_MS = 250

/** A locally provisioned, single-use attempt. Acceptance never proves physical completion. */
export function openFixedKobraLinkControl(input: {
  binding: PrinterBinding
  allowedOrigins: readonly string[]
  connectionGeneration: number
  clock: { monotonicNow(): number }
  publish(observation: ControlObservation | null): void
  signal: AbortSignal
  fetch?: KobraLinkFetch | undefined
}) {
  const local = readKobraLinkPrinterBinding(input.binding)
  const mapping = readPrinterBinding(input.binding)
  if (!local || !mapping) throw new Error('KobraLink control unavailable')
  const controller = new AbortController()
  const signal = AbortSignal.any([input.signal, controller.signal])
  let prepared = false
  let attempted = false
  let request: Parameters<PauseDriver['pauseOnce']>[0] | undefined
  let authorized = false
  function current() {
    if (signal.aborted || readKobraLinkPrinterBinding(input.binding) !== local)
      throw new Error('KobraLink control unavailable')
  }
  const client = createKobraLinkClient({
    origin: local.origin,
    allowedOrigins: input.allowedOrigins,
    signal,
    fetch: (url, init) => {
      current()
      if (
        init.method === 'POST' &&
        !new URL(url).pathname.startsWith('/api/auth/')
      ) {
        if (!request || request.signal.aborted)
          throw new Error('KobraLink control unavailable')
        if (!authorized) {
          if (!request.beforeSend()) throw new Error('KobraLink guard denied')
          authorized = true
        }
      }
      return (input.fetch ?? fetch)(url, init)
    },
  })
  async function send(
    action: Parameters<NonNullable<PauseDriver['execute']>>[0],
    args: Record<string, unknown>,
    next: Parameters<PauseDriver['pauseOnce']>[0],
  ) {
    current()
    if (
      !prepared ||
      attempted ||
      next.binding !== input.binding ||
      next.signal.aborted
    )
      throw new Error('KobraLink control unavailable')
    attempted = true
    request = next
    if (action === 'pause' || action === 'resume' || action === 'cancel')
      await client.controlPrinter(local!.id, action)
    else if (action === 'set_light') {
      const command = KobraLinkExtendedCommand.parse({ action, args })
      if (command.action !== 'set_light')
        throw new Error('KobraLink control unavailable')
      await client.controlBridgePrinter(local!.id, {
        action: 'light',
        args: command.args,
      })
    } else if (
      action === 'start_print' &&
      typeof args.file === 'string' &&
      args.file.startsWith('kobralink-library:')
    ) {
      const id = args.file.slice('kobralink-library:'.length)
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(id))
        throw new Error('Invalid library file')
      await client.startLibraryFile(
        { id: local!.id, deviceId: local!.deviceId },
        id,
      )
    } else
      await client.controlExtendedPrinter(
        local!.id,
        KobraLinkExtendedCommand.parse({ action, args }),
      )
    return { acknowledged: true }
  }
  let sequence = 1
  let sent: Parameters<NonNullable<PauseDriver['execute']>>[0] | undefined
  function observed(
    observation: Awaited<ReturnType<typeof client.getPrinterObservation>>,
    cancelled: boolean,
  ): ControlObservation {
    const now = input.clock.monotonicNow()
    return Object.freeze({
      assignmentId: mapping!.assignment_id,
      printerKey: mapping!.printer_key,
      connectionGeneration: input.connectionGeneration,
      sequence: ++sequence,
      ready: true,
      printState:
        observation.printState === 'printing' ||
        observation.printState === 'paused'
          ? observation.printState
          : cancelled && observation.lastJob?.outcome === 'cancelled'
            ? 'cancelled'
            : observation.printState === 'standby' ||
                observation.printState === 'complete'
              ? 'idle'
              : observation.printState === 'error'
                ? 'error'
                : 'unknown',
      readyObservedMono: now,
      printStateObservedMono: now,
      receivedMono: now,
    })
  }
  const driver: PauseDriver = {
    execute(action, args, next) {
      sent = action
      return send(action, args, next)
    },
    pauseOnce(next) {
      sent = next.action ?? 'pause'
      return send(sent, next.args ?? {}, next)
    },
    /**
     * The bridge returns acceptance only, so the state is read back from it
     * after the send and never assumed. A lifecycle action waits, bounded,
     * for the bridge to report its target state; any other action is
     * answered by the first available read after the send. No read, or a
     * state that never arrives, stays unconfirmed.
     */
    async waitForPaused(request) {
      const action = sent
      if (
        !attempted ||
        !action ||
        request.binding !== input.binding ||
        request.signal.aborted
      )
        return null
      const target =
        action === 'pause'
          ? 'paused'
          : action === 'resume'
            ? 'printing'
            : action === 'cancel'
              ? 'cancelled'
              : undefined
      const deadline = input.clock.monotonicNow() + CONFIRM_WAIT_MS
      for (;;) {
        try {
          current()
          const observation = await client.getPrinterObservation({
            id: local!.id,
            deviceId: local!.deviceId,
          })
          current()
          if (request.signal.aborted) return null
          if (observation.availability === 'available') {
            const latest = observed(observation, action === 'cancel')
            if (!target || latest.printState === target) {
              input.publish(latest)
              return latest
            }
          }
        } catch {
          return null
        }
        if (input.clock.monotonicNow() >= deadline) return null
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer)
            request.signal.removeEventListener('abort', done)
            resolve()
          }
          const timer = setTimeout(done, CONFIRM_POLL_MS)
          request.signal.addEventListener('abort', done, { once: true })
        })
        if (request.signal.aborted) return null
      }
    },
  }
  return {
    driver,
    async prepare() {
      current()
      if (prepared) throw new Error('KobraLink attempt already prepared')
      const credential = readKobraLinkCredential(local!)
      await client.authenticate({
        ownership: 'fresh_owned',
        mode: 'signin',
        name: credential.name,
        email: credential.email,
        password: credential.password,
      })
      const observation = await client.getPrinterObservation({
        id: local!.id,
        deviceId: local!.deviceId,
      })
      current()
      if (observation.availability !== 'available')
        throw new Error('KobraLink control unavailable')
      const now = input.clock.monotonicNow()
      input.publish({
        assignmentId: mapping!.assignment_id,
        printerKey: mapping!.printer_key,
        connectionGeneration: input.connectionGeneration,
        sequence: 1,
        ready: true,
        printState:
          observation.printState === 'printing' ||
          observation.printState === 'paused'
            ? observation.printState
            : observation.printState === 'standby' ||
                observation.printState === 'complete'
              ? 'idle'
              : observation.printState === 'error'
                ? 'error'
                : 'unknown',
        readyObservedMono: now,
        printStateObservedMono: now,
        receivedMono: now,
      })
      prepared = true
    },
    async close() {
      controller.abort()
      client.clearSession()
      input.publish(null)
    },
  }
}
