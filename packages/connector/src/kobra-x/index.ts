import { randomUUID } from 'node:crypto'
import { connect, createSecureContext } from 'node:tls'
import { MqttClient } from 'mqtt'
import {
  readKobraXInfo,
  recoverKobraXCredentials,
  type KobraXRecoveryProtocol,
} from './discovery.ts'
import { createKobraXStatus } from './status.ts'

export { discoverKobraX } from './discovery.ts'

export async function connectKobraX(options: {
  address: string
  printerKey: string
  clientIdentity?: { cert: Buffer | string; key: Buffer | string }
  recovery: KobraXRecoveryProtocol
  pinSha256?: string
  httpPort?: number
  mqttPort?: number
  reconnectMs?: number
  onError?: (error: Error) => void
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
    await recoverKobraXCredentials(info, options.recovery, options.httpPort)
  const state = createKobraXStatus(options.printerKey, address)
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
      connectTimeout: 3000,
      reconnectPeriod: options.reconnectMs ?? 1000,
      resubscribe: false,
      queueQoSZero: false,
    },
  )
  let accepted = false
  let ready = false
  const close = () =>
    client.endAsync(true).then(() => {
      state.disconnect()
    })
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
      client.subscribe(`${reports}+/report`, (error, grants) => {
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
    if (
      !type ||
      !Object.hasOwn(queries, type) ||
      suffix !== 'report' ||
      extra !== undefined
    )
      return
    try {
      state.report(type, JSON.parse(payload.toString()))
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
    cameraUrl: state.cameraUrl,
    fingerprint: () => pin,
    close,
  }
}
