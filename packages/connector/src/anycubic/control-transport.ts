import type { buildAnycubicCommand } from './commands.ts'
import { connect as tlsConnect } from 'node:tls'
import { createHash } from 'node:crypto'
import { MqttClient } from 'mqtt'

export interface AnycubicControlTransportOptions {
  host: string
  port: number
  serial: string
  credentials: { username: string; password: string }
  caPem?: string
  certPem?: string
  keyPem?: string
  pinSha256?: string
  limits: {
    maxFrameBytes: number
    connectTimeoutMs: number
    maxInflight: number
    reconnectDelayMs: number
    maxReconnects: number
  }
  signal: AbortSignal
  onReport: (payload: Buffer, topic: string) => void
  onConnection: (state: 'connected' | 'disconnected' | 'closed') => void
}

export function createAnycubicControlTransport(
  options: AnycubicControlTransportOptions,
) {
  const {
    host,
    port,
    serial,
    credentials,
    limits,
    signal,
    onReport,
    onConnection,
  } = options
  if (
    !host ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !/^[A-Za-z0-9_/-]{1,128}$/.test(serial) ||
    !credentials.username ||
    !credentials.password ||
    Object.values(limits).some(
      (value) => !Number.isSafeInteger(value) || value < 0,
    ) ||
    limits.maxFrameBytes < 2 ||
    limits.maxFrameBytes > 1048576 ||
    limits.connectTimeoutMs < 1 ||
    limits.connectTimeoutMs > 60000 ||
    limits.maxInflight < 1 ||
    limits.maxInflight > 128 ||
    limits.reconnectDelayMs < 1 ||
    limits.reconnectDelayMs > 60000 ||
    limits.maxReconnects > 100 ||
    (options.pinSha256 !== undefined &&
      !/^[a-fA-F0-9]{64}$/.test(options.pinSha256))
  )
    throw new Error('Invalid Anycubic transport options')
  const topic = `anycubic/anycubicCloud/v1/printer/public/${serial}/+/report`
  function matches(value: string) {
    const prefix = `anycubic/anycubicCloud/v1/printer/public/${serial}/`
    return (
      value.startsWith(prefix) &&
      /^[A-Za-z]+\/report$/.test(value.slice(prefix.length))
    )
  }
  let stopped = false
  let retries = 0
  let inflight = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let settle: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    settle = resolve
  })
  const client = new MqttClient(
    () => {
      let remaining = 0
      let multiplier = 1
      let body = 0
      let header = true
      inflight = 0
      const socket = tlsConnect({
        host,
        port,
        ca: options.caPem,
        ...(options.certPem && options.keyPem
          ? { cert: options.certPem, key: options.keyPem }
          : {}),
        minVersion: 'TLSv1.2',
        // A configured exact certificate pin is an alternative trust anchor.
        rejectUnauthorized: !options.pinSha256,
      })
      socket.prependListener('data', (chunk: Buffer) => {
        for (const byte of chunk) {
          if (body > 0) {
            body--
            continue
          }
          if (header) {
            header = false
            remaining = 0
            multiplier = 1
            continue
          }
          remaining += (byte & 127) * multiplier
          if (remaining + 5 > limits.maxFrameBytes || multiplier > 2097152) {
            socket.destroy()
            return
          }
          if (byte & 128) multiplier *= 128
          else {
            body = remaining
            header = true
          }
        }
      })
      socket.once('secureConnect', () => {
        if (
          options.pinSha256 &&
          createHash('sha256')
            .update(socket.getPeerCertificate().raw)
            .digest('hex') !== options.pinSha256.toLowerCase()
        )
          socket.destroy(new Error('TLS pin mismatch'))
      })
      return socket
    },
    {
      manualConnect: true,
      protocolVersion: 4,
      username: credentials.username,
      password: credentials.password,
      connectTimeout: limits.connectTimeoutMs,
      reconnectPeriod: 0,
      clean: true,
      resubscribe: false,
      queueQoSZero: false,
    },
  )
  function close() {
    if (stopped) return done
    stopped = true
    clearTimeout(timer)
    signal.removeEventListener('abort', close)
    client.end(true, {}, () => {
      try {
        onConnection('closed')
      } finally {
        settle()
      }
    })
    return done
  }
  client.on('error', () => {
    /* Connection errors are handled by close/retry without exposing credentials. */
  })
  client.on('connect', () => {
    client.subscribe(topic, { qos: 0 }, (error, grants) => {
      if (
        error ||
        !grants?.length ||
        grants.some((grant) => grant.qos === 128)
      ) {
        void close()
        return
      }
      if (stopped) return
      retries = 0
      try {
        onConnection('connected')
      } catch {
        void close()
      }
    })
  })
  client.on('packetreceive', (packet) => {
    if (
      packet.cmd === 'publish' &&
      (!matches(packet.topic) || ++inflight > limits.maxInflight)
    )
      void close()
  })
  client.on('message', (receivedTopic, payload) => {
    inflight = Math.max(0, inflight - 1)
    if (stopped || !matches(receivedTopic)) return
    try {
      onReport(payload, receivedTopic)
    } catch {
      void close()
    }
  })
  client.on('close', () => {
    if (stopped) return
    try {
      onConnection('disconnected')
    } catch {
      void close()
      return
    }
    if (retries++ >= limits.maxReconnects) {
      void close()
      return
    }
    timer = setTimeout(() => {
      if (!stopped) client.reconnect()
    }, limits.reconnectDelayMs)
  })
  signal.addEventListener('abort', close, { once: true })
  if (signal.aborted) void close()
  else client.connect()
  function publish(
    request: ReturnType<typeof buildAnycubicCommand>,
    beforeSend: () => boolean,
  ): Promise<void> {
    const payload = JSON.stringify(request)
    if (stopped || !client.connected || Buffer.byteLength(payload) > 1024)
      return Promise.reject(new Error('Anycubic request unavailable'))
    return new Promise((resolve, reject) => {
      if (!beforeSend()) {
        reject(new Error('Anycubic request denied'))
        return
      }
      client.publish(
        `anycubic/anycubicCloud/v1/printer/public/${serial}/${request.type}/request`,
        payload,
        { qos: 0, retain: false },
        (error) => {
          if (error) reject(new Error('Anycubic request unavailable'))
          else resolve()
        },
      )
    })
  }
  function publishFile(
    topic: string,
    payload: string,
    beforeSend: () => boolean,
  ): Promise<void> {
    if (
      stopped ||
      !client.connected ||
      !['info', 'file', 'print'].some(
        (type) =>
          topic ===
          `anycubic/anycubicCloud/v1/slicer/printer/${serial}/${type}`,
      ) ||
      Buffer.byteLength(payload) > 2048
    )
      return Promise.reject(new Error('Anycubic request unavailable'))
    return new Promise((resolve, reject) => {
      if (!beforeSend()) {
        reject(new Error('Anycubic request denied'))
        return
      }
      client.publish(topic, payload, { qos: 0, retain: false }, (error) => {
        if (error) reject(new Error('Anycubic request unavailable'))
        else resolve()
      })
    })
  }
  /**
   * Requests of the `models.ts` models go to the `web` topic: the one their
   * reference was validated with on hardware (evidence doc, source H1).
   */
  function publishWeb(
    request: Readonly<{ type: string }>,
    beforeSend: () => boolean,
  ): Promise<void> {
    const payload = JSON.stringify(request)
    if (
      stopped ||
      !client.connected ||
      !['info', 'light', 'print'].includes(request.type) ||
      Buffer.byteLength(payload) > 1024
    )
      return Promise.reject(new Error('Anycubic request unavailable'))
    return new Promise((resolve, reject) => {
      if (!beforeSend()) {
        reject(new Error('Anycubic request denied'))
        return
      }
      client.publish(
        `anycubic/anycubicCloud/v1/web/printer/${serial}/${request.type}`,
        payload,
        { qos: 0, retain: false },
        (error) => {
          if (error) reject(new Error('Anycubic request unavailable'))
          else resolve()
        },
      )
    })
  }
  return { done, close, publish, publishFile, publishWeb }
}
