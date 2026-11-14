import { readFileSync } from 'node:fs'
import { PrinterState } from '@open3dfarmmanager/farm-protocol'
import { parseBambuBinding, type BambuBinding } from './configuration.ts'
import { readBambuCredentials } from './credentials.ts'
import { decodeBambuReport } from './report.ts'
import { createBambuTransport, type BambuTransportOptions } from './transport.ts'

type Fields = Omit<PrinterState, 'printerKey' | 'observedAt'>
export type BambuRuntimeEvent =
  | { kind: 'snapshot'; printer: PrinterState; source: { serial: string; epoch: number; fieldObservedAtMonoMs: Readonly<Partial<Record<keyof Fields, number>>> } }
  | { kind: 'unavailable'; printerKey: string; reason: 'connecting' | 'disconnected' | 'stale' | 'invalid-response' | 'unavailable' }

export function createBambuRuntimeSubscription(input: {
  binding: BambuBinding
  signal: AbortSignal
  onEvent: (event: BambuRuntimeEvent) => void
  staleAfterMs?: number
  transport?: typeof createBambuTransport
}) {
  const binding = parseBambuBinding({ ...input.binding, allowedEndpoints: [{ host: input.binding.host, port: input.binding.port }] })
  const ttl = input.staleAfterMs ?? 30_000
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 300_000) throw Error('Invalid Bambu expiry')
  const controller = new AbortController()
  const signal = AbortSignal.any([input.signal, controller.signal])
  let epoch = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let fields: Partial<Fields> = {}
  let times: Partial<Record<keyof Fields, number>> = {}
  let connected = false
  const clear = () => { fields = {}; times = {}; clearTimeout(timer) }
  const unavailable = (reason: Extract<BambuRuntimeEvent, { kind: 'unavailable' }>['reason']) => {
    if (!signal.aborted) input.onEvent({ kind: 'unavailable', printerKey: binding.printerKey, reason })
  }
  function publish() {
    clearTimeout(timer)
    const now = performance.now()
    for (const key of Object.keys(times) as (keyof Fields)[]) {
      const stamp = times[key]
      if (stamp !== undefined && now - stamp >= ttl) { delete times[key]; delete fields[key] }
    }
    const parsed = PrinterState.safeParse({ ...fields, printerKey: binding.printerKey, observedAt: Date.now() })
    if (parsed.success) input.onEvent({ kind: 'snapshot', printer: parsed.data, source: { serial: binding.serial, epoch, fieldObservedAtMonoMs: Object.freeze({ ...times }) } })
    else unavailable('stale')
    const stamps = Object.values(times)
    if (stamps.length) timer = setTimeout(publish, Math.max(1, Math.min(...stamps) + ttl - now))
  }
  const done = (async () => {
    let transport: ReturnType<typeof createBambuTransport> | undefined
    try {
      if (signal.aborted) return
      unavailable('connecting')
      const credentials = readBambuCredentials(binding)
      const options: BambuTransportOptions = {
        ...binding, credentials, signal,
        ...(binding.caFile ? { caPem: readFileSync(binding.caFile, 'utf8') } : {}),
        limits: { maxFrameBytes: 131072, connectTimeoutMs: 10000, maxInflight: 16, reconnectDelayMs: 1000, maxReconnects: 5 },
        onConnection(state) {
          if (signal.aborted) return
          clear()
          connected = state === 'connected'
          if (connected) { epoch++; unavailable('connecting') }
          else unavailable(state === 'disconnected' ? 'disconnected' : 'unavailable')
        },
        onReport(payload) {
          if (signal.aborted || !connected) return
          const result = decodeBambuReport(payload.toString('utf8'))
          if (result.kind === 'ignored') return
          if (result.kind === 'invalid') { clear(); unavailable('invalid-response'); return }
          const { kind: _, ...observed } = result
          // Unknown explicit states must not retain a previously recognized state.
          const raw: unknown = JSON.parse(payload.toString('utf8'))
          if (raw && typeof raw === 'object' && 'print' in raw && raw.print && typeof raw.print === 'object' && 'gcode_state' in raw.print && observed.state === undefined) {
            delete fields.state; delete times.state
          }
          const now = performance.now()
          for (const key of Object.keys(observed) as (keyof Fields)[]) times[key] = now
          fields = { ...fields, ...observed }
          publish()
        },
      }
      transport = (input.transport ?? createBambuTransport)(options)
      await transport.done
    } catch {
      unavailable('unavailable')
    } finally {
      controller.abort()
      clear()
      await transport?.close()
    }
  })()
  return { done, close: () => { controller.abort(); clear() } }
}
