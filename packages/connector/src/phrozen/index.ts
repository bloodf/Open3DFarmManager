import { randomBytes } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { isIPv4 } from 'node:net'

// Phrozen demonstrates ChituManager on the Revo 14K with V138:
// https://www.youtube.com/watch?v=ngnSR3nWJGw
// Wire contract: https://github.com/cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0
export const PhrozenModel = 'Sonic Mighty Revo 14K'
export const PhrozenFirmware = ['V138', 'V153'] as const

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Malformed Phrozen SDCP object')
  }
  return value as Record<string, unknown>
}

function parse(frame: unknown) {
  if (typeof frame !== 'string' || frame.length > 1024 * 1024) {
    throw new Error('Malformed Phrozen SDCP frame')
  }
  return object(JSON.parse(frame))
}

function identity(frame: string) {
  const { Id, Data } = parse(frame)
  const data = object(Data)
  const attributes = object(data.Attributes ?? data)
  const { MachineName, MainboardID, FirmwareVersion, ProtocolVersion } =
    attributes
  if (
    MachineName !== PhrozenModel ||
    typeof FirmwareVersion !== 'string' ||
    !PhrozenFirmware.some((firmware) => firmware === FirmwareVersion) ||
    ProtocolVersion !== 'V3.0.0'
  ) {
    throw new Error('Unsupported Phrozen SDCP model, firmware or protocol')
  }
  if (
    typeof Id !== 'string' ||
    !Id ||
    Id.length > 128 ||
    typeof MainboardID !== 'string' ||
    !/^[a-f0-9]{1,64}$/i.test(MainboardID)
  ) {
    throw new Error('Malformed Phrozen SDCP identity')
  }
  return Object.freeze({
    id: Id,
    board: MainboardID,
    model: MachineName,
    firmware: FirmwareVersion,
  })
}

export async function connectPhrozen(
  host: string,
  { udpPort = 3000, wsPort = 3030, timeoutMs = 2500 } = {},
) {
  if (!isIPv4(host))
    throw new Error('Expected a provisioned Phrozen IPv4 address')

  if (
    [udpPort, wsPort].some(
      (port) => !Number.isInteger(port) || port < 1 || port > 65535,
    )
  ) {
    throw new Error('Invalid Phrozen port')
  }
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 2_147_483_647
  ) {
    throw new Error('Invalid Phrozen timeout')
  }

  const device = await new Promise<ReturnType<typeof identity>>(
    (resolve, reject) => {
      const socket = createSocket('udp4')
      let settled = false
      const timer = setTimeout(
        () => finish(new Error('Phrozen discovery timeout')),
        timeoutMs,
      )

      function finish(error?: Error, result?: ReturnType<typeof identity>) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.close()
        if (result) resolve(result)
        else reject(error)
      }

      socket.on('error', finish)
      socket.on('message', (message, sender) => {
        if (sender.address !== host || sender.port !== udpPort) return
        try {
          finish(undefined, identity(message.toString()))
        } catch (error) {
          finish(
            error instanceof Error
              ? error
              : new Error('Invalid Phrozen discovery reply'),
          )
        }
      })
      socket.send('M99999', udpPort, host, (error) => {
        if (error) finish(error)
      })
    },
  )

  return Object.freeze({
    identity: device,
    authentication: 'none' as const,
    readStatus() {
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const { board, id } = device
        const requestId = randomBytes(8).toString('hex')
        const socket = new WebSocket(`ws://${host}:${wsPort}/websocket`)
        let settled = false
        let accepted = false
        let status: Record<string, unknown> | undefined
        const timer = setTimeout(
          () => fail(new Error('Phrozen status timeout')),
          timeoutMs,
        )

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

        socket.onopen = () => {
          if (settled) return
          socket.send(
            JSON.stringify({
              Id: id,
              Topic: `sdcp/request/${board}`,
              Data: {
                Cmd: 0,
                Data: {},
                RequestID: requestId,
                MainboardID: board,
                TimeStamp: Math.floor(Date.now() / 1000),
                From: 0,
              },
            }),
          )
        }
        socket.onerror = () => fail(new Error('Phrozen transport error'))
        socket.onclose = () => fail(new Error('Phrozen disconnected'))
        socket.onmessage = ({ data }) => {
          if (settled || data === 'pong') return
          try {
            const frame = parse(data)
            if (
              frame.Topic === `sdcp/status/${board}` &&
              frame.MainboardID === board
            ) {
              status = object(frame.Status)
              const { CurrentStatus } = status
              if (
                !Array.isArray(CurrentStatus) ||
                !CurrentStatus.length ||
                !CurrentStatus.every(Number.isInteger)
              ) {
                throw new Error('Malformed Phrozen machine status')
              }
            }
            if (frame.Topic === `sdcp/response/${board}`) {
              const response = object(frame.Data)
              if (response.RequestID !== requestId) return
              const { Ack } = object(response.Data)
              if (
                response.Cmd !== 0 ||
                response.MainboardID !== board ||
                typeof Ack !== 'number' ||
                !Number.isInteger(Ack)
              ) {
                throw new Error('Malformed Phrozen acknowledgment')
              }
              if (Ack !== 0)
                throw new Error(`Phrozen denied status (Ack ${Ack})`)
              accepted = true
            }
            if (accepted && status) {
              close()
              resolve(status)
            }
          } catch (error) {
            fail(error)
          }
        }
      })
    },
  })
}
