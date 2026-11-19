import { randomUUID } from 'node:crypto'
import { connect, createSecureContext } from 'node:tls'
import { MqttClient } from 'mqtt'
import { readKobraXInfo, recoverKobraXCredentials } from './discovery.ts'
import { createKobraXControl } from './control.ts'
import { createKobraXFacts } from './facts.ts'
import { createKobraXRequests, parseKobraXReport } from './requests.ts'
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
  onError?: (error: Error) => void
  /** Called once per finished job with the filament used per ACE slot. */
  onJobUsage?: (usage: KobraXJobUsage) => void
  /** How long a result is awaited after a command. */
  resultTimeoutMs?: number
  motionResultTimeoutMs?: number
  usageSettleMs?: number
}) {
  const { address, clientIdentity } = options
  if (!clientIdentity?.cert || !clientIdentity.key)
    throw new Error('Kobra X client certificate and key are required')
  let secureContext
  try {
    secureContext = createSecureContext({
      ...clientIdentity,
      minVersion: 'TLSv1.2',
    })
  } catch {
    throw new Error('Kobra X client certificate or key is invalid')
  }
  let pin = options.pinSha256?.toLowerCase()
  if (pin !== undefined && !/^[a-f0-9]{64}$/.test(pin))
    throw new Error('Invalid Kobra X certificate fingerprint')
  const info = await readKobraXInfo(address, options.httpPort)
  const { modeId, deviceId, username, password } =
    await recoverKobraXCredentials(info, options.httpPort)
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
  const reports = `${path}/public/${modeId}/${deviceId}/`
  const queries = {
    info: 'query',
    status: 'query',
    print: 'query',
    tempature: 'query',
    multiColorBox: 'getInfo',
  }
  let fingerprint: string | undefined
  let connectionError: Error | undefined
  const client = new MqttClient(
    () => {
      connectionError = undefined
      fingerprint = undefined
      const socket = connect({
        host: address,
        port: options.mqttPort ?? 9883,
        secureContext,
        rejectUnauthorized: false,
      })
      socket.cork()
      socket.once('secureConnect', () => {
        fingerprint = socket
          .getPeerCertificate()
          .fingerprint256?.replaceAll(':', '')
          .toLowerCase()
        if (!fingerprint || (pin && fingerprint !== pin)) {
          connectionError = new Error(
            'Kobra X printer certificate fingerprint mismatch',
          )
          socket.destroy(connectionError)
          return
        }
        socket.uncork()
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
    client.on('error', (error: Error & { code?: string | number }) => {
      if (connectionError) return
      else if (typeof error.code === 'number')
        failed(new Error('Kobra X MQTT credentials were refused'))
      else if (/alert.*(?:certificate|unknown ca)/i.test(error.message))
        failed(new Error('Kobra X printer rejected the client certificate'))
      else failed(new Error('Kobra X TLS or MQTT connection failed'))
    })
    client.on('close', () => {
      state.disconnect()
      facts.reset()
      if (connectionError) {
        failed(connectionError)
        if (ready) void close()
      } else if (!ready && !accepted && fingerprint) {
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
      pin ??= fingerprint
      // The public tree carries `<type>/report` and the per-request
      // `response` acknowledgements ("received" only).
      client.subscribe(`${reports}#`, (error, grants) => {
        if (error || !grants?.length || grants[0]?.qos === 128) {
          failed(new Error('Kobra X status subscription failed'))
          return
        }
        for (const [type, action] of Object.entries(queries)) {
          client.publish(
            `${path}/${modeId}/${deviceId}/${type}`,
            JSON.stringify({
              type,
              action,
              msgid: randomUUID(),
              data: {},
            }),
          )
        }
        clearTimeout(timer)
        ready = true
        resolve()
      })
    })
  })
  client.on('message', (topic, payload) => {
    if (!topic.startsWith(reports) || payload.length > 65536) return
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
      if (Object.hasOwn(queries, type)) state.report(type, message)
      const report = parseKobraXReport(type, message)
      if (!report) return
      facts.report(report)
      usage.report(report)
      requests.handleReport(report)
    } catch {
      // Invalid telemetry is ignored.
    }
  })
  try {
    client.connect()
    await started
  } catch (error) {
    await close()
    throw error
  }
  return {
    snapshot: state.snapshot,
    control,
    facts: facts.get,
    cameraUrl: state.cameraUrl,
    fingerprint: () => pin,
    close,
  }
}
