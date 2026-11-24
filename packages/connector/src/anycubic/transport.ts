import { MqttClient } from 'mqtt'
import {
  anycubicTlsTrustError,
  connectAnycubicTls,
  type AnycubicPairingRequired,
  type PinMismatch,
} from './tls-trust.ts'

export interface AnycubicLanClientOptions {
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
  onReport: (payload: Buffer) => void
  onConnection: (state: 'connected' | 'disconnected' | 'closed') => void
  onTrustError?: (error: PinMismatch | AnycubicPairingRequired) => void
}

export function createAnycubicLanClient(options: AnycubicLanClientOptions) {
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
      const socket = connectAnycubicTls(
        {
          host,
          port,
          ...(options.caPem !== undefined ? { ca: options.caPem } : {}),
          ...(options.certPem && options.keyPem
            ? { cert: options.certPem, key: options.keyPem }
            : {}),
          minVersion: 'TLSv1.2',
        },
        options.pinSha256?.toLowerCase(),
      )
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
  client.on('error', (error: Error & { code?: string | number }) => {
    const trustError = anycubicTlsTrustError(error)
    if (!trustError) return
    void close()
    options.onTrustError?.(trustError)
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
      onReport(payload)
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
  return { done, close }
}
