import type { ApiJobLifecycle } from './api-job-lifecycle.ts'
import type { MoonrakerLinkHealth } from '../moonraker/subscription.ts'
import { readMoonrakerFirmware } from '../moonraker/firmware.ts'
import { readMoonrakerMachineProfile } from '../machine-profile/moonraker.ts'
import { fetchMoonrakerConfigfile } from '../machine-profile/moonraker-fetch.ts'
import { createMachineProfileGate } from '../machine-profile/on-change.ts'
import type { MachineProfile } from '../../../farm-protocol/src/machine-profile.ts'
import { getSpoolmanMaterials } from './spoolman-materials.ts'
import { parseMoonrakerActiveSpoolId } from '../moonraker/active-spool.ts'
import { inventoryAt, summarizeSpoolman } from './spool-inventory.ts'
import {
  validateMoonrakerInput,
  moonrakerAuthHeaders,
  moonrakerSession,
} from '../config/moonraker.ts'
import type { AnycubicCollectorConfig } from '../config/anycubic.ts'
import type { CrealityCollectorConfig } from '../config/creality.ts'
import { createAnycubicCollection } from './anycubic-collection.ts'
import { createFormlabsCollection } from './formlabs-collection.ts'
import { readPrivateJsonFile } from '../config/local.ts'
import type { FormlabsCollectorConfig } from '../formlabs/config.ts'
import { createSdcpCollection } from './sdcp-collection.ts'
import { createKobraXCollection } from './kobra-x-collection.ts'
import type { KobraXBinding } from '../config/kobra-x.ts'
import { createBambuRuntimeSubscription } from '../bambu/runtime.ts'
import type { createBambuTransport } from '../bambu/transport.ts'
import type { RawPrinterObservation } from './farm-snapshot-provider.ts'
import { createKobraLinkRuntimeSubscription } from '../kobralink/runtime.ts'
import { createPrusaLinkCollection } from './prusa-link-collection.ts'
import {
  parseCollectorConfig,
  type PrusaCollectorConfig,
} from '../prusa/config.ts'
import { readKobraClientCertMaterial } from '../config/kobra-x-cert.ts'
import { createCrealityCollection } from './creality-collection.ts'
import type { MoonrakerEvent } from '../moonraker/subscription.ts'
import { createMoonrakerHistoryImport } from '../moonraker/history-import.ts'
import type { KobraLinkFetch } from '../kobralink/client.ts'
import {
  createSpoolmanProvider,
  type SpoolmanSnapshot,
} from './spoolman-provider.ts'
import type { RawMoonrakerUnavailable } from '../moonraker/subscription.ts'
import { join } from 'node:path'
import type { PrinterState } from '@open3dfarmmanager/farm-protocol'
import type { ExtendedControlAction } from '../../../farm-protocol/src/control-actions.ts'
import { TelemetryQueue, type QueueLoss } from '../cloud/queue.ts'
import { type LocalCollectorConfig } from '../config/local.ts'
import { assertUnscopedCollection } from './queue-scope.ts'
import type { LibraryJobLinks } from './library-job-links.ts'

export type Diagnostic =
  | { kind: 'queued'; depth: number }
  | { kind: 'queue-lock-recovered' }
  | { kind: 'queue-lock-mutex-left' }
  | {
      kind: 'loss'
      phase: 'recovery' | 'retention'
      expired: number
      capacity: number
      partialTail: boolean
    }
  | {
      kind: 'unavailable'
      reason:
        | 'connecting'
        | 'offline'
        | 'stale'
        | 'not-ready'
        | 'invalid-response'
        | 'unsupported-protocol'
    }
  | {
      kind: 'summary'
      queued: number
      expired: number
      capacity: number
      partialTail: boolean
      unavailable: number
    }

/** Local telemetry persistence only. No identity writes, sending or command path. */
export async function collectLocalTelemetry(input: {
  configPath: string
  dataDirectory: string
  signal: AbortSignal
  onDiagnostic: (diagnostic: Diagnostic) => void
}): Promise<void> {
  const config = parseCollectorConfig(
    readPrivateJsonFile(input.configPath, { maxBytes: 65536 }),
  )
  if (input.signal.aborted) return
  const directory = join(input.dataDirectory, 'telemetry')
  assertUnscopedCollection(directory)
  const queue = new TelemetryQueue(
    directory,
    Date.now(),
    {},
    {
      beforeRecovery: () => {
        assertUnscopedCollection(directory)
        return undefined
      },
    },
  )
  try {
    await collectIntoQueue({ ...input, config, queue })
  } finally {
    queue.close()
  }
}

/** Caller owns the already-open queue and its scope/close lifecycle. */
export async function collectIntoQueue(input: {
  apiJobs?: ApiJobLifecycle
  controlsFor?: (
    printerKey: string,
  ) => readonly ExtendedControlAction[] | undefined
  onControlsRefresh?: (refresh: () => void) => void
  onLoss?: (value: Extract<Diagnostic, { kind: 'loss' }>) => void
  linkHealthFor?: (printerKey: string) => MoonrakerLinkHealth | undefined
  discoverMoonrakerObjects?: boolean
  /** Import Moonraker's finished-job history on connect and after reconnects. */
  importMoonrakerHistory?: boolean
  bambuTransport?: (
    options: Parameters<typeof createBambuTransport>[0],
  ) => Pick<ReturnType<typeof createBambuTransport>, 'done' | 'close'>
  anycubicTransport?: Parameters<
    typeof createAnycubicCollection
  >[0]['transport']
  kobraFetch?: KobraLinkFetch
  /**
   * Confirmed native Kobra X bindings from the private onboarding store. Read
   * only; the caller excludes assignments still awaiting inventory
   * confirmation. Tests may pass loopback endpoints.
   */
  kobraX?: {
    bindings: readonly KobraXBinding[]
    endpoints?: Parameters<typeof createKobraXCollection>[0]['endpoints']
    connect?: Parameters<typeof createKobraXCollection>[0]['connect']
  }
  config:
    | LocalCollectorConfig
    | CrealityCollectorConfig
    | AnycubicCollectorConfig
    | FormlabsCollectorConfig
    | PrusaCollectorConfig
    | import('../config/sdcp.ts').SdcpCollectorConfig
  onInventory?: (snapshot: SpoolmanSnapshot) => void
  onPrinterState?: (printer: PrinterState) => void
  onRawObservation?: (observation: RawPrinterObservation) => void
  onRawUnavailable?: (event: RawMoonrakerUnavailable) => void
  /** Links a finished job to the library version that was started on this printer (#385). */
  libraryLinks?: Pick<LibraryJobLinks, 'attach'>
  queue: TelemetryQueue
  signal: AbortSignal
  onDiagnostic: (diagnostic: Diagnostic) => void
}): Promise<void> {
  const config = parseCollectorConfig(
    input.config,
    !!input.kobraX?.bindings.length,
  )
  const { queue } = input
  const { createMoonrakerSubscription } =
    await import('../moonraker/subscription.ts')
  const controller = new AbortController()
  const signal = AbortSignal.any([input.signal, controller.signal])
  const subscriptions: Array<{ done: Promise<void> }> = []
  let failure: { error: unknown } | undefined
  // Bound terminal diagnostics per run. Collection continues after this budget.
  let diagnosticBudget = 1024
  const totals = {
    queued: 0,
    expired: 0,
    capacity: 0,
    partialTail: false,
    unavailable: 0,
  }
  // Transitions are detected in memory; the first observation after a restart emits none.
  // Changes during unreachability fold into one transition from the last-known state at reconnect.
  const lastState = new Map<string, PrinterState['state']>()
  const latestStates = new Map<string, PrinterState>()
  const lastControls = new Map<string, string>()
  // The machine block is queued only when it changes.
  const machineGate = createMachineProfileGate()
  function diagnostic(value: Diagnostic) {
    if (diagnosticBudget-- > 0) input.onDiagnostic(value)
  }
  function loss(value: QueueLoss, phase: 'recovery' | 'retention') {
    totals.expired += value.expired
    totals.capacity += value.capacity
    totals.partialTail ||= value.partialTail
    if (value.expired || value.capacity || value.partialTail) {
      input.onLoss?.({ kind: 'loss', phase, ...value })
      diagnostic({ kind: 'loss', phase, ...value })
    }
  }
  function fail(error: unknown) {
    failure ??= { error }
    controller.abort()
  }
  function onEvent(
    event: MoonrakerEvent | { kind: 'snapshot'; printer: PrinterState },
  ) {
    if (signal.aborted) return
    try {
      if (event.kind === 'unavailable') {
        totals.unavailable++
        diagnostic({ kind: 'unavailable', reason: event.reason })
        const previous = latestStates.get(event.printerKey)
        if (previous && previous.state !== 'offline') {
          const { controls: _controls, ...rest } = previous
          onEvent({
            kind: 'snapshot',
            printer: {
              ...rest,
              state: 'offline',
              observedAt: Math.max(Date.now(), previous.observedAt + 1),
            },
          })
        }
      } else {
        input.onPrinterState?.(event.printer)
        const now = Date.now()
        // Degraded storage drops records; they count as lost, never as queued.
        const lostBefore = queue.storageLost
        const previous = lastState.get(event.printer.printerKey)
        lastState.set(event.printer.printerKey, event.printer.state)
        if (previous !== undefined && previous !== event.printer.state) {
          const transition = queue.enqueueTransition(
            {
              printerKey: event.printer.printerKey,
              from: previous,
              to: event.printer.state,
              observedAt: event.printer.observedAt,
              ...(event.printer.statusReason
                ? { reason: event.printer.statusReason }
                : {}),
            },
            now,
          )
          totals.queued++
          loss(transition.loss, 'retention')
        }
        const printer =
          input.libraryLinks?.attach(event.printer) ?? event.printer
        const controls =
          printer.state === 'offline'
            ? undefined
            : input.controlsFor?.(printer.printerKey)
        const { controls: _controls, ...withoutControls } = printer
        const current = {
          ...withoutControls,
          ...(controls === undefined ? {} : { controls: [...controls] }),
        }
        latestStates.set(printer.printerKey, current)
        lastControls.set(printer.printerKey, JSON.stringify(controls ?? null))
        const queued = machineGate.apply(current)
        let receipt
        try {
          receipt = queue.enqueue(queued, now)
        } catch (error) {
          machineGate.forget(printer.printerKey)
          throw error
        }
        totals.queued++
        loss(receipt.loss, 'retention')
        const dropped = queue.storageLost - lostBefore
        totals.queued -= dropped
        // enqueue returns only after its append/compaction and fsync succeed.
        if (!dropped) diagnostic({ kind: 'queued', depth: queue.depth })
      }
    } catch (error) {
      fail(error)
    }
  }
  input.onControlsRefresh?.(() => {
    for (const printer of latestStates.values()) {
      if (printer.state === 'offline') continue
      const controls = input.controlsFor?.(printer.printerKey)
      if (
        lastControls.get(printer.printerKey) !==
        JSON.stringify(controls ?? null)
      )
        onEvent({
          kind: 'snapshot',
          printer: {
            ...printer,
            observedAt: Math.max(Date.now(), printer.observedAt + 1),
          },
        })
    }
  })
  const materialReads = new Set<Promise<void>>()
  let inventory: SpoolmanSnapshot | undefined
  let lastInventoryObservedAt = -1
  try {
    if (queue.recoveredStaleLock) diagnostic({ kind: 'queue-lock-recovered' })
    if (queue.recoveryMutexLeft) diagnostic({ kind: 'queue-lock-mutex-left' })
    loss(queue.recovery, 'recovery')
    if (config.spoolman && !signal.aborted) {
      const provider = createSpoolmanProvider({
        config: config.spoolman,
        signal,
        onSnapshot(value) {
          inventory = value
          const summary = summarizeSpoolman(value)
          const projected = summary
            ? inventoryAt(summary, 0, Date.now())
            : undefined
          if (projected && projected.observedAt > lastInventoryObservedAt) {
            try {
              queue.enqueueInventory(projected, Date.now())
              lastInventoryObservedAt = projected.observedAt
            } catch (error) {
              fail(error)
            }
          }
          input.onInventory?.(value)
        },
      })
      subscriptions.push({ done: provider.done.catch(fail) })
    }
    for (const assignment of config.printers) {
      if (signal.aborted) break
      const selected = validateMoonrakerInput({
        assignment,
        allowedOrigins: config.allowedOrigins,
        limits: config.limits,
      })
      let cached: RawPrinterObservation['materialsObservation'] | undefined
      let cachedInventory: SpoolmanSnapshot | undefined
      let pending = false
      let firmwareObservation: RawPrinterObservation['firmwareObservation']
      let nextFirmwareRead = -Infinity
      let firmwarePending = false
      let machine: MachineProfile | undefined
      let nextMachineRead = -Infinity
      let machinePending = false
      let latest: RawPrinterObservation | undefined
      // Keep the driver-owned snapshot separate from the optional Spoolman
      // enrichment so expired evidence cannot be copied into later records.
      let moonrakerState: PrinterState | undefined
      let publishedMaterials: string | undefined
      function freshMaterials() {
        if (
          cachedInventory !== inventory ||
          inventory?.kind !== 'observed' ||
          (cached && cached.observedAtMonoMs + 5000 <= performance.now())
        )
          cached = undefined
        return cached?.materials
      }
      function publishMaterialChange() {
        if (!moonrakerState || signal.aborted) return
        const materials = moonrakerState.materials ?? freshMaterials()
        const fingerprint = JSON.stringify(materials ?? null)
        if (fingerprint === publishedMaterials) return
        publishedMaterials = fingerprint
        const previous = latestStates.get(assignment.printerKey)
        onEvent({
          kind: 'snapshot',
          printer: {
            ...moonrakerState,
            ...(materials ? { materials } : {}),
            observedAt: Math.max(Date.now(), (previous?.observedAt ?? 0) + 1),
          },
        })
      }
      const history = input.importMoonrakerHistory
        ? createMoonrakerHistoryImport({
            printerKey: assignment.printerKey,
            selected,
            signal,
            record(state) {
              try {
                const lostBefore = queue.storageLost
                const receipt = queue.enqueue(state, Date.now())
                totals.queued++
                loss(receipt.loss, 'retention')
                totals.queued -= queue.storageLost - lostBefore
              } catch (error) {
                fail(error)
              }
            },
          })
        : undefined
      const linkHealth = input.linkHealthFor?.(assignment.printerKey)
      const subscription = createMoonrakerSubscription({
        ...(linkHealth ? { linkHealth } : {}),
        ...(input.discoverMoonrakerObjects ? { discoverObjects: true } : {}),
        jobFields: true,
        assignment,
        allowedOrigins: config.allowedOrigins,
        limits: config.limits,
        signal,
        onRawObservation(value) {
          input.apiJobs?.observe(value)
          latest = value
          const at = performance.now()
          if (
            !firmwarePending &&
            at >= nextFirmwareRead &&
            input.onRawObservation
          ) {
            firmwarePending = true
            nextFirmwareRead = at + 600_000
            const read = readMoonrakerFirmware({
              async request() {
                const session = moonrakerSession(
                  selected.origin,
                  selected.limits,
                )
                const headers = session
                  ? await session.getAuthHeaders()
                  : moonrakerAuthHeaders(selected.origin, selected.limits)
                const response = await fetch(
                  new URL('/machine/update/status', selected.origin),
                  {
                    headers,
                    redirect: 'error',
                    credentials: 'omit',
                    signal: AbortSignal.any([
                      signal,
                      AbortSignal.timeout(
                        Math.min(5000, selected.limits.requestTimeoutMs),
                      ),
                    ]),
                  },
                )
                if (!response.ok || !response.body)
                  throw Error('Firmware unavailable')
                const reader = response.body.getReader()
                const chunks: Uint8Array[] = []
                let size = 0
                try {
                  while (true) {
                    const chunk = await reader.read()
                    if (chunk.done) break
                    size += chunk.value.length
                    if (size > selected.limits.maxMessageBytes)
                      throw Error('Firmware response bound')
                    chunks.push(chunk.value)
                  }
                } finally {
                  await reader.cancel()
                }
                return JSON.parse(Buffer.concat(chunks).toString()).result
              },
            })
              .then((firmware) => {
                if (signal.aborted || latest?.epoch !== value.epoch) return
                firmwareObservation = firmware
                  ? { firmware, observedAtMonoMs: at }
                  : undefined
                input.onRawObservation?.({
                  ...latest,
                  receivedAtMonoMs: performance.now(),
                  ...(firmwareObservation ? { firmwareObservation } : {}),
                })
              })
              .catch(() => {})
              .finally(() => {
                firmwarePending = false
                materialReads.delete(read)
              })
            materialReads.add(read)
          }
          // Like firmware, read only when the agent runtime observes this printer.
          if (
            !machinePending &&
            at >= nextMachineRead &&
            input.onRawObservation
          ) {
            machinePending = true
            nextMachineRead = at + 600_000
            const machineRead = readMoonrakerMachineProfile({
              request: () =>
                fetchMoonrakerConfigfile({
                  origin: selected.origin,
                  limits: selected.limits,
                  signal,
                }),
            })
              .then((profile) => {
                if (!signal.aborted && profile) machine = profile
              })
              .catch(() => {})
              .finally(() => {
                machinePending = false
                materialReads.delete(machineRead)
              })
            materialReads.add(machineRead)
          }
          freshMaterials()
          publishMaterialChange()
          input.onRawObservation?.({
            ...value,
            ...(firmwareObservation ? { firmwareObservation } : {}),
            ...(cached ? { materialsObservation: cached } : {}),
          })
          if (!selected || !inventory || pending || !input.onRawObservation)
            return
          pending = true
          const snapshot = inventory
          const started = performance.now()
          const read = getSpoolmanMaterials(async () => {
            const session = moonrakerSession(selected.origin, selected.limits)
            const headers = session
              ? await session.getAuthHeaders()
              : moonrakerAuthHeaders(selected.origin, selected.limits)
            const response = await fetch(
              new URL('/server/spoolman/spool_id', selected.origin),
              {
                headers,
                redirect: 'error',
                credentials: 'omit',
                signal: AbortSignal.any([
                  signal,
                  AbortSignal.timeout(
                    Math.min(5000, selected.limits.requestTimeoutMs),
                  ),
                ]),
              },
            )
            if (!response.ok || !response.body) return null
            const reader = response.body.getReader()
            const chunks: Uint8Array[] = []
            let size = 0
            try {
              while (true) {
                const chunk = await reader.read()
                if (chunk.done) break
                size += chunk.value.length
                if (size > 4096) return null
                chunks.push(chunk.value)
              }
            } finally {
              await reader.cancel()
            }
            const body = JSON.parse(Buffer.concat(chunks).toString())
            return parseMoonrakerActiveSpoolId(body)
          }, snapshot)
            .then((materials) => {
              if (
                !materials ||
                signal.aborted ||
                latest?.epoch !== value.epoch ||
                inventory !== snapshot ||
                performance.now() - started >= 5000
              )
                return
              cached = { materials, observedAtMonoMs: started }
              cachedInventory = snapshot
              publishMaterialChange()
              const current = latest
              input.onRawObservation?.({
                ...current,
                ...(firmwareObservation ? { firmwareObservation } : {}),
                receivedAtMonoMs: performance.now(),
                materialsObservation: cached,
              })
            })
            .catch(() => {})
            .finally(() => {
              pending = false
              materialReads.delete(read)
            })
          materialReads.add(read)
        },
        onRawUnavailable(event) {
          firmwareObservation = undefined
          latest = undefined
          cached = undefined
          publishMaterialChange()
          moonrakerState = undefined
          publishedMaterials = undefined
          input.onRawUnavailable?.(event)
        },
        onEvent: (event) => {
          if (event.kind === 'snapshot') {
            moonrakerState = machine
              ? { ...event.printer, machine }
              : event.printer
            const materials = moonrakerState.materials ?? freshMaterials()
            publishedMaterials = JSON.stringify(materials ?? null)
            onEvent({
              ...event,
              printer: {
                ...moonrakerState,
                ...(materials ? { materials } : {}),
              },
            })
          } else onEvent(event)
          if (event.kind === 'unavailable')
            input.apiJobs?.unavailable(assignment.printerKey)
          else if (!signal.aborted) input.apiJobs?.record(event.printer)
          if (!history) return
          if (event.kind === 'unavailable') history.reconnecting()
          else history.observe(event.printer.state)
        },
      })
      // Attach rejection handling immediately, before starting another printer.
      subscriptions.push({ done: subscription.done.catch(fail) })
    }
    if (config.version === 2) {
      for (const binding of config.kobralink.printers) {
        let epoch = 1
        let sourceTime = -1
        let observedMono = -1
        let disconnectedMono = -1
        // The bridge keeps reporting a finished job with a fresh `updatedAt`
        // on every poll. The first observation of an ended job fixes its end
        // time; it is repeated unchanged until another job ends.
        let lastJob: PrinterState['lastJob']
        let ended = false
        // The bridge is polled every second and its `updatedAt` always moves.
        // Only a changed state is queued for the cloud: an unchanged snapshot
        // per poll would keep the telemetry upload, and with it the
        // credential proof slot signalling shares, permanently busy. The live
        // view still receives every raw observation.
        let queuedState: string | undefined
        const certMissing = () =>
          Boolean(
            binding.clientCertFile &&
            !readKobraClientCertMaterial(binding.clientCertFile).ok,
          )
        const emitMissingCert = () => {
          const now = performance.now()
          disconnectedMono = now
          const printer: PrinterState = {
            printerKey: binding.printerKey,
            state: 'offline',
            statusReason: 'client-certificate-missing',
            observedAt: Date.now(),
          }
          input.onRawObservation?.({
            printerKey: binding.printerKey,
            epoch,
            printer,
            receivedAtMonoMs: now,
            fieldObservedAtMonoMs: { connection: now },
          })
          const key = 'offline:client-certificate-missing'
          if (queuedState !== key) {
            queuedState = key
            onEvent({ kind: 'snapshot', printer })
          }
        }
        const unavailable = () => {
          if (certMissing()) {
            emitMissingCert()
            return
          }
          queuedState = undefined
          input.onRawUnavailable?.({
            printerKey: binding.printerKey,
            epoch: epoch++,
          })
          onEvent({
            kind: 'unavailable',
            printerKey: binding.printerKey,
            reason: 'offline',
          })
        }
        if (certMissing()) emitMissingCert()
        const sub = createKobraLinkRuntimeSubscription({
          binding,
          allowedOrigins: config.kobralink.allowedOrigins,
          signal,
          ...(input.kobraFetch ? { fetch: input.kobraFetch } : {}),
          onUnavailable: unavailable,
          onStatus(status) {
            const now = performance.now()
            const missingCert =
              status.connectionReason === 'client_certificate_missing' ||
              certMissing()
            if (status.availability === 'disconnected' || missingCert) {
              disconnectedMono = now
              const printer: PrinterState = {
                printerKey: binding.printerKey,
                state: 'offline',
                ...(missingCert
                  ? { statusReason: 'client-certificate-missing' }
                  : {}),
                observedAt: Date.now(),
              }
              input.onRawObservation?.({
                printerKey: binding.printerKey,
                epoch,
                printer,
                receivedAtMonoMs: now,
                fieldObservedAtMonoMs: { connection: now },
              })
              const nextKey = missingCert
                ? 'offline:client-certificate-missing'
                : 'offline'
              if (queuedState !== nextKey) {
                queuedState = nextKey
                onEvent({ kind: 'snapshot', printer })
              }
              return
            }
            const age =
              status.observedAt === null
                ? Infinity
                : Date.now() - status.observedAt
            if (
              status.availability !== 'available' ||
              status.progress === null ||
              status.observedAt === null ||
              age < 0 ||
              age >= 5000 ||
              now - age < disconnectedMono ||
              status.observedAt < sourceTime ||
              status.printState === 'unknown' ||
              status.printState === 'pausing'
            ) {
              unavailable()
              return
            }
            if (status.observedAt > sourceTime) {
              sourceTime = status.observedAt
              observedMono = now - age
            }
            if (observedMono < 0 || now - observedMono >= 5000) {
              unavailable()
              return
            }
            const state =
              status.printState === 'standby' ||
              status.printState === 'complete'
                ? 'idle'
                : status.printState
            if (status.lastJob && !ended) lastJob = status.lastJob
            ended = status.lastJob !== undefined
            const printer: PrinterState = {
              printerKey: binding.printerKey,
              state,
              progress: status.progress,
              observedAt: status.observedAt,
              ...(lastJob ? { lastJob } : {}),
            }
            input.onRawObservation?.({
              printerKey: binding.printerKey,
              epoch,
              printer,
              receivedAtMonoMs: now,
              fieldObservedAtMonoMs: {
                webhooks: observedMono,
                printState: observedMono,
                progress: observedMono,
              },
            })
            const queued = JSON.stringify([state, status.progress, lastJob])
            if (queuedState !== queued) {
              queuedState = queued
              onEvent({
                kind: 'snapshot',
                printer,
                sourceEventtime: sourceTime,
              })
            }
          },
        })
        subscriptions.push({ done: sub.done.catch(fail) })
      }
    }
    if (config.version === 3) {
      for (const binding of config.bambu.printers) {
        if (signal.aborted) break
        let epoch = 1
        const sub = createBambuRuntimeSubscription({
          binding,
          signal,
          staleAfterMs: 5000,
          ...(input.bambuTransport ? { transport: input.bambuTransport } : {}),
          onEvent(event) {
            if (event.kind === 'unavailable') {
              input.onRawUnavailable?.({
                printerKey: binding.printerKey,
                epoch: epoch++,
              })
              onEvent({
                kind: 'unavailable',
                printerKey: binding.printerKey,
                reason: 'offline',
              })
              return
            }
            input.onRawObservation?.({
              printerKey: binding.printerKey,
              epoch,
              printer: event.printer,
              ...(event.firmwareObservation
                ? { firmwareObservation: event.firmwareObservation }
                : {}),
              receivedAtMonoMs: performance.now(),
              fieldObservedAtMonoMs: {
                bambu: event.source.fieldObservedAtMonoMs,
              },
            })
            onEvent(event)
          },
        })
        subscriptions.push({ done: sub.done.catch(fail) })
      }
    }
    if (config.version === 4) {
      for (const binding of config.creality.printers) {
        if (signal.aborted) break
        const sub = createCrealityCollection({
          binding,
          signal,
          onObservation(observation) {
            input.onRawObservation?.(observation)
            onEvent({ kind: 'snapshot', printer: observation.printer })
          },
          onUnavailable(epoch) {
            input.onRawUnavailable?.({ printerKey: binding.printerKey, epoch })
            onEvent({
              kind: 'unavailable',
              printerKey: binding.printerKey,
              reason: 'stale',
            })
          },
        })
        subscriptions.push({ done: sub.done.catch(fail) })
      }
    }
    if (config.version === 5) {
      for (const binding of config.anycubic.printers) {
        if (signal.aborted) break
        const sub = createAnycubicCollection({
          ...(input.anycubicTransport
            ? { transport: input.anycubicTransport }
            : {}),
          binding,
          signal,
          onObservation(value) {
            input.onRawObservation?.(value)
            onEvent({ kind: 'snapshot', printer: value.printer })
          },
          onUnavailable(epoch) {
            input.onRawUnavailable?.({ printerKey: binding.printerKey, epoch })
            onEvent({
              kind: 'unavailable',
              printerKey: binding.printerKey,
              reason: 'stale',
            })
          },
        })
        subscriptions.push({ done: sub.done.catch(fail) })
      }
    }
    if (config.version === 8) {
      for (const binding of config.drivers) {
        const sub = createPrusaLinkCollection({
          binding,
          signal,
          timeoutMs: Math.min(30000, config.limits.requestTimeoutMs),
          onObservation(value) {
            input.onRawObservation?.(value)
          },
          onUnavailable(epoch) {
            input.onRawUnavailable?.({ printerKey: binding.printerKey, epoch })
          },
        })
        subscriptions.push({ done: sub.done.catch(fail) })
      }
    }
    if (config.version === 7) {
      for (const binding of config.formlabs.printers) {
        const sub = createFormlabsCollection({
          binding,
          signal,
          onObservation(value) {
            // PreForm reports host data. Keep it out of printer history.
            input.onRawObservation?.(value)
          },
          onUnavailable(epoch) {
            input.onRawUnavailable?.({ printerKey: binding.printerKey, epoch })
            onEvent({
              kind: 'unavailable',
              printerKey: binding.printerKey,
              reason: 'stale',
            })
          },
        })
        subscriptions.push({ done: sub.done.catch(fail) })
      }
    }
    if (config.version === 6) {
      for (const binding of config.sdcp.printers) {
        const sub = createSdcpCollection({
          binding,
          signal,
          onObservation(value) {
            input.onRawObservation?.(value)
            onEvent({ kind: 'snapshot', printer: value.printer })
          },
          onUnavailable(epoch, reason) {
            if (reason.startsWith('Unsupported SDCP protocol version:'))
              diagnostic({
                kind: 'unavailable',
                reason: 'unsupported-protocol',
              })
            input.onRawUnavailable?.({ printerKey: binding.printerKey, epoch })
            onEvent({
              kind: 'unavailable',
              printerKey: binding.printerKey,
              reason: 'stale',
            })
          },
        })
        subscriptions.push({ done: sub.done.catch(fail) })
      }
    }
    for (const binding of input.kobraX?.bindings ?? []) {
      if (signal.aborted) break
      const sub = createKobraXCollection({
        binding,
        signal,
        ...(input.kobraX?.endpoints
          ? { endpoints: input.kobraX.endpoints }
          : {}),
        ...(input.kobraX?.connect ? { connect: input.kobraX.connect } : {}),
        onObservation(value) {
          input.onRawObservation?.(value)
          onEvent({ kind: 'snapshot', printer: value.printer })
        },
        onUnavailable(epoch) {
          input.onRawUnavailable?.({ printerKey: binding.printerKey, epoch })
          onEvent({
            kind: 'unavailable',
            printerKey: binding.printerKey,
            reason: 'stale',
          })
        },
      })
      subscriptions.push({ done: sub.done.catch(fail) })
    }
    await Promise.all(subscriptions.map((subscription) => subscription.done))
  } catch (error) {
    fail(error)
  } finally {
    controller.abort()
    await Promise.all(materialReads)
    await Promise.all(subscriptions.map((subscription) => subscription.done))
    try {
      input.onDiagnostic({ kind: 'summary', ...totals })
    } catch (error) {
      fail(error)
    }
  }
  if (failure) throw failure.error
}
