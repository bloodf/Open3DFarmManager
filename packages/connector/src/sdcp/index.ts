import { randomBytes } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { isIPv4 } from 'node:net'

// Wire references and firmware observations are collected in docs/protocols/sdcp.md.
// CBD SDCP v3: https://github.com/cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0
// Centauri stock firmware: https://github.com/bjan/pycentauri/blob/main/docs/PROTOCOL.md
// Saturn 16K: https://github.com/alfiedennen/sdcp-saturn-4-ultra
const models = {
  'Centauri Carbon': { kind: 'fdm' },
  'Saturn 4 Ultra 16K': { kind: 'resin', historyFirmware: 'V1.5.6' },
  'Saturn 4 Ultra': { kind: 'resin' },
  'Mars 5 Ultra': { kind: 'resin' },
} as const

type Identity = {
  id: string
  board: string
  model: keyof typeof models
  firmware: string
}
type Options = { udpPort?: number; wsPort?: number; timeoutMs?: number }

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Malformed SDCP object')
  }
  return value as Record<string, unknown>
}

function parse(message: string) {
  if (message.length > 1024 * 1024) throw new Error('Oversized SDCP frame')
  return record(JSON.parse(message))
}

function discovery(message: string): Identity {
  const envelope = parse(message)
  const data = record(envelope.Data)
  const attrs = data.Attributes === undefined ? data : record(data.Attributes)
  const {
    MachineName: model,
    MainboardID: board,
    FirmwareVersion: firmware,
    ProtocolVersion: version,
  } = attrs
  const { Id: id } = envelope
  if (typeof model !== 'string' || !Object.hasOwn(models, model)) {
    throw new Error('Unsupported SDCP model')
  }
  // The stock V1.1.46 Centauri discovery reply can omit ProtocolVersion.
  if (
    version !== 'V3.0.0' &&
    !(
      version === undefined &&
      model === 'Centauri Carbon' &&
      firmware === 'V1.1.46'
    )
  ) {
    throw new Error('Unsupported SDCP version')
  }
  if (
    typeof id !== 'string' ||
    !/^[a-f0-9]{1,64}$/i.test(id) ||
    typeof board !== 'string' ||
    !/^[a-f0-9]{1,64}$/i.test(board) ||
    typeof firmware !== 'string' ||
    !/^V?\d+(?:\.\d+){1,4}$/.test(firmware)
  ) {
    throw new Error('Malformed SDCP identity')
  }
  return { id, board, model: model as Identity['model'], firmware }
}

/** Unicast probe of a locally provisioned IPv4 address. Advertised addresses are ignored. */
export async function connectSdcp(host: string, options: Options = {}) {
  if (!isIPv4(host)) throw new Error('Expected a provisioned SDCP IPv4 address')
  const { udpPort = 3000, wsPort = 3030, timeoutMs = 2500 } = options
  const identity = await new Promise<Identity>((resolve, reject) => {
    const socket = createSocket('udp4')
    const finish = () => {
      clearTimeout(timer)
      socket.close()
    }
    const timer = setTimeout(() => {
      finish()
      reject(new Error('SDCP discovery timeout'))
    }, timeoutMs)
    socket.once('error', (error) => {
      finish()
      reject(error)
    })
    socket.on('message', (message, sender) => {
      if (sender.address !== host || sender.port !== udpPort) return
      finish()
      try {
        resolve(discovery(message.toString()))
      } catch (error) {
        reject(error)
      }
    })
    socket.send('M99999', udpPort, host, (error) => {
      if (!error) return
      finish()
      reject(error)
    })
  })

  const { board, model, firmware } = identity
  const profile = models[model]
  const hasHistory =
    'historyFirmware' in profile && profile.historyFirmware === firmware

  function request(
    cmd: 0 | 320,
    status = false,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://${host}:${wsPort}/websocket`)
      const requestId = randomBytes(8).toString('hex')
      const timer = setTimeout(
        () => fail(new Error('SDCP response timeout')),
        timeoutMs,
      )
      let settled = false
      let snapshot: Record<string, unknown> | undefined
      let accepted = false

      function close() {
        settled = true
        clearTimeout(timer)
        socket.close()
      }
      function fail(error: unknown) {
        if (settled) return
        close()
        reject(error)
      }
      function succeed(data: Record<string, unknown>) {
        close()
        resolve(data)
      }

      socket.onopen = () => {
        socket.send(
          JSON.stringify({
            Id: profile.kind === 'fdm' ? board : identity.id,
            Topic: `sdcp/request/${board}`,
            Data: {
              Cmd: cmd,
              Data: {},
              RequestID: requestId,
              MainboardID: board,
              TimeStamp:
                profile.kind === 'fdm'
                  ? Date.now()
                  : Math.floor(Date.now() / 1000),
              From: profile.kind === 'fdm' ? 1 : 0,
            },
          }),
        )
      }
      socket.onerror = () => fail(new Error('SDCP transport error'))
      socket.onclose = () => fail(new Error('SDCP disconnected'))
      socket.onmessage = ({ data }) => {
        if (settled || data === 'pong') return
        try {
          if (typeof data !== 'string') throw new Error('Malformed SDCP frame')
          const frame = parse(data)
          if (
            status &&
            frame.Topic === `sdcp/status/${board}` &&
            frame.MainboardID === board
          ) {
            snapshot = record(frame.Status)
          }
          if (frame.Topic === `sdcp/response/${board}`) {
            const response = record(frame.Data)
            if (response.RequestID !== requestId) return
            if (response.Cmd !== cmd || response.MainboardID !== board) {
              throw new Error('Malformed SDCP response')
            }
            const body = record(response.Data)
            if (typeof body.Ack !== 'number' || !Number.isInteger(body.Ack)) {
              throw new Error('Malformed SDCP acknowledgment')
            }
            if (body.Ack !== 0)
              throw new Error(`SDCP denied command ${cmd} (Ack ${body.Ack})`)
            if (!status) return succeed(body)
            accepted = true
          }
          if (accepted && snapshot) succeed(snapshot)
        } catch (error) {
          fail(error)
        }
      }
    })
  }

  return Object.freeze({
    identity: Object.freeze(identity),
    kind: profile.kind,
    authentication: 'none' as const,
    cameraUrl:
      model === 'Centauri Carbon' && firmware === 'V1.1.46'
        ? `http://${host}:3031/video`
        : undefined,
    async readStatus() {
      const status = await request(0, true)
      const machineStatus = status.CurrentStatus ?? status.CurrenStatus
      if (!(
        Number.isInteger(machineStatus) ||
        (Array.isArray(machineStatus) &&
          machineStatus.length > 0 &&
          machineStatus.every(Number.isInteger))
      )) {
        throw new Error('Malformed SDCP machine status')
      }
      return status
    },
    historySupported: hasHistory,
    async readHistoryIds(): Promise<string[]> {
      if (!hasHistory)
        throw new Error('SDCP history is unsupported on this firmware')
      const { HistoryData } = await request(320)
      if (
        !Array.isArray(HistoryData) ||
        !HistoryData.every(
          (item) => typeof item === 'string' && item.length > 0,
        )
      ) {
        throw new Error('Malformed SDCP history')
      }
      return HistoryData
    },
  })
}
