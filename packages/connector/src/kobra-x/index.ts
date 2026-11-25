import { randomUUID } from 'node:crypto'
import { createSecureContext } from 'node:tls'
import { MqttClient } from 'mqtt'
import {
  anycubicTlsTrustError,
  connectAnycubicTls,
  normalizeAnycubicPin,
} from '../anycubic/tls-trust.ts'
import { readKobraXInfo, recoverKobraXCredentials } from './discovery.ts'
import { createKobraXControl } from './control.ts'
import { createKobraXFacts, type KobraXFacts } from './facts.ts'
import {
  createKobraXRequests,
  parseKobraXReport,
  reportRefusal,
  type KobraXReport,
  type KobraXReportIdentity,
} from './requests.ts'
import {
  createKobraXQueryEvidence,
  kobraXQueries as queries,
  type KobraXQuery,
} from './state-evidence.ts'
import { createKobraXStatus } from './status.ts'
import { createKobraXUsage, type KobraXJobUsage } from './usage.ts'

export { discoverKobraX } from './discovery.ts'
export type { KobraXOutcome } from './requests.ts'
export type { KobraXControl } from './control.ts'
export type { KobraXJobUsage } from './usage.ts'

export async function connectKobraX(options: {
  address: string
  printerKey: string
  clientIdentity?: { cert: Buffer | string; key: Buffer | string }
  pinSha256?: string
  httpPort?: number
  mqttPort?: number
  reconnectMs?: number
  signal?: AbortSignal
  expectedIdentity?: { deviceId: string; modelId: string }
  onError?: (error: Error) => void
  onDisconnect?: () => void
  onReport?: (
    report: KobraXReport,
    snapshot: ReturnType<ReturnType<typeof createKobraXStatus>['snapshot']>,
    facts: KobraXFacts,
    source: 'query' | 'request' | 'other',
  ) => void
  /** Called once per finished job with the filament used per ACE slot. */
  onJobUsage?: (usage: KobraXJobUsage) => void
  /** How long a result is awaited after a command. */
  resultTimeoutMs?: number
  motionResultTimeoutMs?: number
  usageSettleMs?: number
  /** `printer-assigned` only for firmware that replaces report msgids. */
  reportIdentity?: KobraXReportIdentity
}) {
  const { address, clientIdentity } = options
  if (!clientIdentity?.cert || !clientIdentity.key)
    throw new Error('Kobra X client certificate and key are required')
  let secureContext
  try {
    secureContext = createSecureContext({
      ...clientIdentity,
      // The client certificate is held back until the printer passes its
      // pin check, which needs TLS 1.3 (see `connectAnycubicTls`).
      minVersion: 'TLSv1.3',
    })
  } catch {
    throw new Error('Kobra X client certificate or key is invalid')
  }
  const pin = normalizeAnycubicPin(options.pinSha256)
  const info = await readKobraXInfo(address, options.httpPort, options.signal)
  const { modeId, deviceId, username, password } =
    await recoverKobraXCredentials(info, options.httpPort, options.signal)
  if (
    options.expectedIdentity &&
    (deviceId !== options.expectedIdentity.deviceId ||
      modeId !== options.expectedIdentity.modelId)
  )
    throw new Error('Kobra X printer identity changed')
  options.signal?.throwIfAborted()
  const state = createKobraXStatus(options.printerKey, address)
  const facts = createKobraXFacts()
  const usage = createKobraXUsage({
    facts,
    onUsage: (value) => options.onJobUsage?.(value),
    ...(options.usageSettleMs !== undefined
      ? { settleMs: options.usageSettleMs }
      : {}),
  })
  const path = 'anycubic/anycubicCloud/v1/slicer/printer'
  // Reports arrive on `printer/public` with no `slicer/` segment. Queries stay
  // on `path`.
  const reports = `anycubic/anycubicCloud/v1/printer/public/${modeId}/${deviceId}/`
  const queryEvidence = createKobraXQueryEvidence()
  let tlsEstablished = false
  const client = new MqttClient(
    () => {
      tlsEstablished = false
      const socket = connectAnycubicTls(
        { host: address, port: options.mqttPort ?? 9883, secureContext },
        pin,
        { holdClientIdentity: true },
      )
      socket.once('secureConnect', () => {
        tlsEstablished = !socket.destroyed
      })
      return socket
    },
    {
      manualConnect: true,
      protocolVersion: 4,
      username,
      password,
      clean: true,
      keepalive: 60,
      connectTimeout: 3000,
      reconnectPeriod: options.reconnectMs ?? 1000,
      resubscribe: false,
      queueQoSZero: false,
    },
  )
  let accepted = false
  let ready = false
  const requests = createKobraXRequests({
    topic: (type) => `${path}/${modeId}/${deviceId}/${type}`,
    publish(topic, payload, failed) {
      if (!client.connected) throw new Error('Kobra X is not connected')
      client.publish(topic, payload, (error) => {
        if (error) failed(error)
      })
    },
    ...(options.resultTimeoutMs !== undefined
      ? { resultTimeoutMs: options.resultTimeoutMs }
      : {}),
    ...(options.reportIdentity
      ? { reportIdentity: options.reportIdentity }
      : {}),
  })
  const control = createKobraXControl({
    requests,
    facts,
    state: () => {
      const { state: current, lastJob } = state.snapshot()
      // A job the printer ended itself leaves the status at `error` for the
      // dashboard. It is not a fault of the printer: whether a new command
      // may go out is decided by the printer's own reported idleness.
      return current === 'error' && lastJob?.outcome === 'failed'
        ? 'idle'
        : current
    },
    address,
    httpPort: options.httpPort ?? 18910,
    token: info.token,
    ...(options.resultTimeoutMs !== undefined
      ? { resultTimeoutMs: options.resultTimeoutMs }
      : {}),
    ...(options.motionResultTimeoutMs !== undefined
      ? { motionResultTimeoutMs: options.motionResultTimeoutMs }
      : {}),
  })
  const close = () => {
    usage.close()
    return client.endAsync(true).then(() => {
      state.disconnect()
    })
  }
  function query(type: KobraXQuery) {
    if (!client.connected) return
    // The Orca LAN client sends timestamped, null-data requests for info,
    // print, and multiColorBox. Keep the supplemental query frames as-is.
    const envelope =
      type === 'status' || type === 'tempature'
        ? { data: {} }
        : { timestamp: Date.now(), data: null }
    const msgid = randomUUID()
    queryEvidence.issue(type, msgid)
    client.publish(
      `${path}/${modeId}/${deviceId}/${type}`,
      JSON.stringify({
        type,
        action: queries[type],
        msgid,
        ...envelope,
      }),
    )
  }
  let abort = () => {}
  const started = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Kobra X MQTT connection timed out')),
      4000,
    )
    function failed(error: Error) {
      clearTimeout(timer)
      if (ready) options.onError?.(error)
      else reject(error)
    }
    abort = () => failed(new Error('Kobra X connection aborted'))
    options.signal?.addEventListener('abort', abort, { once: true })
    client.on('error', (error: Error & { code?: string | number }) => {
      const trustError = anycubicTlsTrustError(error)
      if (trustError) {
        tlsEstablished = false
        failed(trustError)
        if (ready) void close()
      } else if (typeof error.code === 'number')
        failed(new Error('Kobra X MQTT credentials were refused'))
      else if (/alert.*(?:certificate|unknown ca)/i.test(error.message))
        failed(new Error('Kobra X printer rejected the client certificate'))
      else failed(new Error('Kobra X TLS or MQTT connection failed'))
    })
    client.on('close', () => {
      state.disconnect()
      facts.reset()
      queryEvidence.reset()
      options.onDisconnect?.()
      if (!ready && !accepted && tlsEstablished) {
        failed(
          new Error(
            'Kobra X printer closed TLS before MQTT login. Check the client certificate.',
          ),
        )
      }
      accepted = false
    })
    client.on('connect', () => {
      accepted = true
      // The public tree carries `<type>/report` and the per-request
      // `response` acknowledgements ("received" only).
      client.subscribe(`${reports}#`, (error, grants) => {
        if (error || !grants?.length || grants[0]?.qos === 128) {
          failed(new Error('Kobra X status subscription failed'))
          return
        }
        for (const type of [
          'info',
          'status',
          'print',
          'tempature',
          'multiColorBox',
        ] as const)
          query(type)
        clearTimeout(timer)
        ready = true
        resolve()
      })
    })
  })
  client.on('message', (topic, payload, packet) => {
    // A broker replay at subscribe time does not establish current state.
    if (packet.retain || !topic.startsWith(reports) || payload.length > 65536)
      return
    const [type, suffix, extra] = topic.slice(reports.length).split('/')
    if (type === 'response' && suffix === undefined) {
      try {
        requests.handleAck(JSON.parse(payload.toString()))
      } catch {
        // Invalid acknowledgements are ignored.
      }
      return
    }
    if (!type || suffix !== 'report' || extra !== undefined) return
    try {
      const message = JSON.parse(payload.toString())
      const report = parseKobraXReport(type, message)
      if (!report) return
      const queryMatch = queryEvidence.classify(report)
      const source =
        queryMatch === 'current'
          ? 'query'
          : requests.isPending(report)
            ? 'request'
            : 'other'
      // Keep passive telemetry for firmware that generates its own IDs.
      // Delayed replies to our queries cannot update control evidence.
      if (queryMatch !== 'stale') {
        if (
          (reportRefusal(report) === null ||
            // A printer-ended or printer-paused job carries a fault code.
            (type === 'print' &&
              (report.state === 'stoped' || report.state === 'paused'))) &&
          (Object.hasOwn(queries, type) || type === 'fan' || type === 'light')
        )
          state.report(type, message)
        facts.report(report)
        usage.report(report)
        // The observer is the caller's code. A failure in it must never keep
        // this report from settling the request that is waiting for it: that
        // request's command is already on the wire.
        try {
          options.onReport?.(report, state.snapshot(), facts.get(), source)
        } catch (error) {
          try {
            options.onError?.(
              error instanceof Error
                ? error
                : new Error('Kobra X report observer failed'),
            )
          } catch {
            // A failing error handler is no more allowed to block settlement.
          }
        }
      }
      // A reply carrying the ID of one of our own state queries belongs to
      // that query and never settles a command.
      if (queryMatch === 'other') requests.handleReport(report)
    } catch {
      // Invalid telemetry is ignored.
    }
  })
  try {
    options.signal?.throwIfAborted()
    client.connect()
    await started
  } catch (error) {
    await close()
    throw error
  } finally {
    options.signal?.removeEventListener('abort', abort)
  }
  return {
    snapshot: state.snapshot,
    control,
    facts: facts.get,
    refreshControlState(effectType?: string) {
      queryEvidence.resetPending()
      query('info')
      query('print')
      if (effectType === 'tempature' || effectType === 'multiColorBox')
        query(effectType)
    },
    /** Unscoped telemetry hint. It confers no capture ownership and is never
     * used by the Connector's passive camera source. */
    cameraUrl: state.cameraUrl,
    fingerprint: () => pin,
    /** Identity the printer proved through recovery; never the credentials. */
    identity: Object.freeze({ deviceId, modelId: modeId, name: info.name }),
    close,
  }
}
