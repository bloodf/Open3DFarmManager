import { reportedModelProfile } from './machine-profile.ts'
import { PrinterState } from '../../../farm-protocol/src/state.ts'
import type { KobraXBinding } from '../config/kobra-x.ts'
import { readKobraClientCertMaterial } from '../config/kobra-x-cert.ts'
import { connectKobraX } from '../kobra-x/index.ts'
import type { RawPrinterObservation } from './farm-snapshot-provider.ts'

type Adapter = Pick<
  Awaited<ReturnType<typeof connectKobraX>>,
  'snapshot' | 'identity' | 'close'
>

const POLL_MS = 500
/** No report for this long: the observation is withdrawn, never kept as fresh. */
const STALE_MS = 30_000
/** Offline or stale this long: credentials are recovered again from scratch. */
const REBUILD_MS = 60_000
const RETRY_MIN_MS = 1_000
const RETRY_MAX_MS = 30_000

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })

/**
 * Status collection for one native Kobra X binding. Read-only: it never sends
 * a command. It fails closed: a missing or invalid client certificate, a
 * server-certificate fingerprint other than the pinned one, or a printer whose
 * proven identity differs from the binding are reported as offline (with the
 * wire's reason where one exists), never as a healthy printer. The printer's MQTT credentials are
 * recovered in memory on every connection and never persisted.
 */
export function createKobraXCollection(input: {
  binding: KobraXBinding
  signal: AbortSignal
  onObservation: (value: RawPrinterObservation) => void
  onUnavailable: (epoch: number) => void
  connect?: typeof connectKobraX
  /** Loopback endpoints for tests. Production uses the printer's fixed ports. */
  endpoints?: { address?: string; httpPort?: number; mqttPort?: number }
  retryMinMs?: number
  pollMs?: number
}): { done: Promise<void> } {
  const { binding, signal } = input
  const connect = input.connect ?? connectKobraX
  let epoch = 1
  const offline = (statusReason?: 'client-certificate-missing') => {
    const now = performance.now()
    input.onObservation({
      printerKey: binding.printerKey,
      epoch,
      printer: PrinterState.parse({
        printerKey: binding.printerKey,
        state: 'offline',
        ...(statusReason ? { statusReason } : {}),
        observedAt: Date.now(),
      }),
      receivedAtMonoMs: now,
      fieldObservedAtMonoMs: { connection: now },
    })
  }
  const invalidate = () => {
    if (!signal.aborted) input.onUnavailable(epoch++)
  }

  async function session(): Promise<'retry' | 'identity'> {
    const loaded = readKobraClientCertMaterial(binding.clientCertFile)
    if (!loaded.ok) {
      offline('client-certificate-missing')
      return 'retry'
    }
    let adapter: Adapter
    try {
      adapter = await connect({
        address: input.endpoints?.address ?? binding.host,
        printerKey: binding.printerKey,
        clientIdentity: {
          cert: loaded.cert.certificatePem,
          key: loaded.cert.keyPem,
        },
        pinSha256: binding.pinSha256,
        ...(input.endpoints?.httpPort
          ? { httpPort: input.endpoints.httpPort }
          : {}),
        ...(input.endpoints?.mqttPort
          ? { mqttPort: input.endpoints.mqttPort }
          : {}),
        onError() {},
      })
    } catch {
      invalidate()
      return 'retry'
    }
    try {
      if (
        adapter.identity.deviceId !== binding.deviceId ||
        adapter.identity.modelId !== binding.modelId
      ) {
        // The wire has no reason for a foreign printer: it is plainly offline.
        offline()
        return 'identity'
      }
      const machine = reportedModelProfile(adapter.identity.modelId)
      let lastReport = 0
      let lastSeen = performance.now()
      let withdrawn = false
      while (!signal.aborted) {
        const printer = adapter.snapshot()
        const now = performance.now()
        if (printer.state !== 'offline' && printer.observedAt !== lastReport) {
          lastReport = printer.observedAt
          lastSeen = now
          withdrawn = false
          const parsed = PrinterState.safeParse({
            ...printer,
            printerKey: binding.printerKey,
          })
          if (parsed.success) {
            const stamped = Object.fromEntries(
              Object.keys(parsed.data).map((key) => [key, now]),
            )
            input.onObservation({
              printerKey: binding.printerKey,
              epoch,
              ...(parsed.data.firmware
                ? {
                    firmwareObservation: {
                      firmware: parsed.data.firmware,
                      observedAtMonoMs: now,
                    },
                  }
                : {}),
              printer: machine ? { ...parsed.data, machine } : parsed.data,
              receivedAtMonoMs: now,
              fieldObservedAtMonoMs: { anycubic: stamped },
            })
          } else {
            withdrawn = true
            invalidate()
          }
        } else if (!withdrawn && now - lastSeen >= STALE_MS) {
          withdrawn = true
          invalidate()
        }
        if (now - lastSeen >= REBUILD_MS) return 'retry'
        await wait(input.pollMs ?? POLL_MS, signal)
      }
      return 'retry'
    } finally {
      await adapter.close().catch(() => undefined)
      invalidate()
    }
  }

  async function run(): Promise<void> {
    const minimum = input.retryMinMs ?? RETRY_MIN_MS
    let delay = minimum
    while (!signal.aborted) {
      const started = performance.now()
      const outcome = await session().catch(() => 'retry' as const)
      if (performance.now() - started > REBUILD_MS) delay = minimum
      // A foreign printer at this address is retried slowly, never trusted.
      await wait(outcome === 'identity' ? RETRY_MAX_MS : delay, signal)
      delay = Math.min(RETRY_MAX_MS, delay * 2)
    }
  }
  return { done: run() }
}
