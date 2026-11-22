import { connect as tlsConnect } from 'node:tls'
import { createHash } from 'node:crypto'
import { MqttClient } from 'mqtt'

import { z } from 'zod'

/**
 * Control-attempt transport. Same TLS trust, MQTT options and frame limits as
 * transport.ts; the only difference is that publish accepts one request built
 * locally by commands.ts instead of the three lifecycle verbs.
 */
const MAX_REQUEST_BYTES = 1024
const sequence = z.string().regex(/^[0-9]{1,16}$/)
const ControlRequest = z.union([
  z.strictObject({
    print: z.strictObject({
      command: z.literal('ams_change_filament'),
      target: z.union([z.number().int().min(0).max(15), z.literal(255)]),
      curr_temp: z.number().finite().min(0).max(300),
      tar_temp: z.number().finite().min(0).max(300),
      sequence_id: sequence,
    }),
  }),
  z.strictObject({
    print: z.strictObject({
      command: z.enum([
        'pause',
        'resume',
        'stop',
        'gcode_line',
        'print_speed',
        'project_file',
      ]),
      param: z.string().max(512).optional(),
      url: z.string().max(800).optional(),
      ams_mapping: z
        .array(z.number().int().min(-1).max(255))
        .max(64)
        .optional(),
      use_ams: z.boolean().optional(),
      sequence_id: sequence,
    }),
  }),
  z.strictObject({
    system: z.strictObject({
      command: z.literal('ledctrl'),
      led_node: z.literal('chamber_light'),
      led_mode: z.enum(['on', 'off']),
      sequence_id: sequence,
    }),
  }),
])
export type BambuControlRequest = z.infer<typeof ControlRequest>

export interface BambuControlTransportOptions {
  host: string
  port: number
  serial: string
  credentials: { username: string; password: string }
  caPem?: string
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
}

export function createBambuControlTransport(
  options: BambuControlTransportOptions,
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
    !/^[A-Za-z0-9_-]{1,128}$/.test(serial) ||
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
    throw new Error('Invalid Bambu transport options')
  const topic = `device/${serial}/report`
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
      (packet.topic !== topic || ++inflight > limits.maxInflight)
    )
      void close()
  })
  client.on('message', (receivedTopic, payload) => {
    inflight = Math.max(0, inflight - 1)
    if (stopped || receivedTopic !== topic) return
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
  function publish(request: unknown, beforeSend: () => boolean): Promise<void> {
    let payload: string
    try {
      payload = JSON.stringify(ControlRequest.parse(request))
    } catch {
      return Promise.reject(new Error('Bambu request unavailable'))
    }
    if (
      stopped ||
      !client.connected ||
      Buffer.byteLength(payload) > MAX_REQUEST_BYTES
    )
      return Promise.reject(new Error('Bambu request unavailable'))
    return new Promise<void>((resolve, reject) => {
      if (beforeSend() !== true) {
        reject(new Error('Bambu request denied'))
        return
      }
      client.publish(
        `device/${serial}/request`,
        payload,
        { qos: 0, retain: false },
        (error) => {
          if (error) reject(new Error('Bambu request unavailable'))
          else resolve()
        },
      )
    })
  }
  return { done, close, publish }
}
