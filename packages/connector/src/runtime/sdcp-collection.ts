import { boundPrinterString } from '@open3dfarmmanager/farm-protocol'
import type { SdcpBinding } from '../config/sdcp.ts'
import { discoverSdcp } from '../discovery/sdcp.ts'
import { connectSdcp } from '../sdcp/index.ts'
import type { RawPrinterObservation } from './farm-snapshot-provider.ts'
import type { z } from 'zod'

type Binding = z.infer<typeof SdcpBinding>
const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
    if (signal.aborted) done()
  })

/** Identity and protocol are rediscovered before each read-only session. */
export function createSdcpCollection(input: {
  binding: Binding
  signal: AbortSignal
  onObservation: (value: RawPrinterObservation) => void
  onUnavailable: (epoch: number, reason: string) => void
  endpoints?: {
    discoveryPort?: number
    websocketPort?: number
    timeoutMs?: number
    pollMs?: number
    retryMs?: number
    staleAfterMs?: number
  }
}) {
  let epoch = 1
  async function run() {
    while (!input.signal.aborted) {
      let adapter: ReturnType<typeof connectSdcp> | undefined
      let unavailable = false
      const withdraw = (reason: string) => {
        if (!unavailable && !input.signal.aborted) {
          unavailable = true
          input.onUnavailable(epoch++, reason)
        }
      }
      try {
        const [identity] = await discoverSdcp({
          target: input.binding.host,
          ...(input.endpoints?.discoveryPort
            ? { port: input.endpoints.discoveryPort }
            : {}),
          timeoutMs: input.endpoints?.timeoutMs ?? 1000,
        })
        if (
          !identity ||
          identity.mainboardId !== input.binding.mainboardId ||
          identity.model.toLowerCase().replace(/^elegoo\s+/, '') !==
            input.binding.model.toLowerCase().replace(/^elegoo\s+/, '')
        )
          throw Error('SDCP identity mismatch or unavailable')
        adapter = connectSdcp(identity, {
          ...(input.endpoints?.websocketPort
            ? { port: input.endpoints.websocketPort }
            : {}),
          staleAfterMs: input.endpoints?.staleAfterMs ?? 30000,
        })
        let last = 0
        const started = Date.now()
        while (!input.signal.aborted) {
          const snapshot = adapter.snapshot()
          if (snapshot && snapshot.observedAt !== last) {
            last = snapshot.observedAt
            unavailable = false
            const mono = performance.now()
            input.onObservation({
              printerKey: input.binding.printerKey,
              epoch,
              printer: {
                printerKey: input.binding.printerKey,
                state: snapshot.state,
                controls: [],
                observedAt: snapshot.observedAt,
                ...(snapshot.progress !== undefined
                  ? { progress: snapshot.progress }
                  : {}),
                identity: {
                  vendor: 'Elegoo',
                  model: boundPrinterString(identity.model),
                  firmware: identity.firmwareVersion,
                },
              },
              receivedAtMonoMs: mono,
              fieldObservedAtMonoMs: {
                sdcp: { state: mono, progress: mono, identity: mono },
              },
            })
          } else if (
            !snapshot &&
            Date.now() - (last || started) >=
              (input.endpoints?.staleAfterMs ?? 30000)
          ) {
            withdraw('stale')
            break
          }
          await wait(input.endpoints?.pollMs ?? 500, input.signal)
        }
      } catch (error) {
        withdraw(error instanceof Error ? error.message : 'SDCP unavailable')
      } finally {
        adapter?.close()
        withdraw('offline')
      }
      await wait(input.endpoints?.retryMs ?? 5000, input.signal)
    }
  }
  return { done: run() }
}
