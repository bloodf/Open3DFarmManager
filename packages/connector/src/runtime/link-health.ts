import {
  LINK_HEARTBEAT_INTERVAL_MS,
  type ConnectorLinkHealth,
  type LinkHealthFrame,
  type PrinterLinkHealth,
} from '../../../farm-protocol/src/link-health.ts'
import {
  MAX_RTC_APPLICATION_BYTES,
  boundRtcApplicationFrame,
} from '../webrtc/rtc-proof-inbox.ts'

function expire<T extends { at: number }>(entries: T[], cutoff: number): void {
  const first = entries.findIndex(({ at }) => at > cutoff)
  entries.splice(0, first === -1 ? entries.length : first)
}

export function createPrinterLinkHealth(
  printerKey: string,
  mono = () => performance.now(),
  wall = Date.now,
) {
  const health: PrinterLinkHealth = {
    printerKey,
    state: 'offline',
    lastSuccessAt: null,
    p50Ms: null,
    p95Ms: null,
    reconnects: 0,
    lastErrorCode: null,
  }
  const samples: { at: number; ms: number }[] = []
  const reconnects: { at: number }[] = []

  return {
    success(startedAt: number, at = mono()) {
      expire(samples, at - 60_000)
      samples.push({ at, ms: Math.max(0, at - startedAt) })
      health.state = 'connected'
      health.lastSuccessAt = wall()
    },
    reconnect() {
      const at = mono()
      expire(reconnects, at - 3_600_000)
      reconnects.push({ at })
      health.state = 'reconnecting'
    },
    failure(code: string) {
      health.state = 'offline'
      health.lastErrorCode = /^[a-zA-Z0-9_.-]{1,64}$/.test(code)
        ? code
        : 'unknown'
    },
    read(): PrinterLinkHealth {
      const at = mono()
      expire(samples, at - 60_000)
      expire(reconnects, at - 3_600_000)
      const sorted = samples.map(({ ms }) => ms).sort((a, b) => a - b)
      return {
        ...health,
        p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1] ?? null,
        p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
        reconnects: reconnects.length,
      }
    },
  }
}

export function encodeLinkHealthFrames(
  kind: LinkHealthFrame['kind'],
  observedAt: number,
  connector: ConnectorLinkHealth,
  printers: PrinterLinkHealth[],
): string[] {
  if (printers.length > 100) throw Error('Link health printer limit')
  const groups: PrinterLinkHealth[][] = [[]]
  const frame: LinkHealthFrame = {
    kind,
    observedAt,
    connector,
    page: 100,
    pages: 100,
    printers: [],
  }
  for (const printer of printers) {
    const group = groups[groups.length - 1]!
    frame.printers = [...group, printer]
    if (Buffer.byteLength(JSON.stringify(frame)) <= MAX_RTC_APPLICATION_BYTES) {
      group.push(printer)
    } else if (group.length) {
      groups.push([printer])
    } else {
      throw Error('Link health frame limit')
    }
  }
  return groups.map((group, index) =>
    boundRtcApplicationFrame(
      JSON.stringify({
        ...frame,
        page: index + 1,
        pages: groups.length,
        printers: group,
      }),
    ),
  )
}

export function startLinkHealthHeartbeat(
  read: () => { connector: ConnectorLinkHealth; printers: PrinterLinkHealth[] },
  emit: (frames: string[]) => void,
  signal: AbortSignal,
): void {
  if (signal.aborted) return
  const timer = setInterval(() => {
    const { connector, printers } = read()
    emit(
      encodeLinkHealthFrames(
        'link-health-heartbeat',
        Date.now(),
        connector,
        printers,
      ),
    )
  }, LINK_HEARTBEAT_INTERVAL_MS)
  timer.unref()
  signal.addEventListener('abort', () => clearInterval(timer), { once: true })
}
