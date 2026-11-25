import { createSocket } from 'node:dgram'
import { isIPv4 } from 'node:net'
import { createPhrozenOperations } from './operations.ts'
import { exchange, object, parse } from './transport.ts'

// Phrozen demonstrates ChituManager on the Revo 14K with V138:
// https://www.youtube.com/watch?v=ngnSR3nWJGw
// Wire contract: https://github.com/cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0
export const PhrozenModel = 'Sonic Mighty Revo 14K'
export const PhrozenFirmware = ['V138', 'V153'] as const

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
  {
    udpPort = 3000,
    wsPort = 3030,
    timeoutMs = 2500,
    confirmTimeoutMs = 15_000,
    pollMs = 500,
    uploadTimeoutMs = 30_000,
  } = {},
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
    [timeoutMs, confirmTimeoutMs, pollMs, uploadTimeoutMs].some(
      (ms) => !Number.isInteger(ms) || ms < 1 || ms > 2_147_483_647,
    )
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

  const endpoint = Object.freeze({
    host,
    port: wsPort,
    timeoutMs,
    id: device.id,
    board: device.board,
  })

  async function readStatus() {
    const { ack, pushed } = await exchange(
      endpoint,
      0,
      {},
      {
        topic: 'status',
        check(frame) {
          const status = object(frame.Status)
          const { CurrentStatus } = status
          if (
            !Array.isArray(CurrentStatus) ||
            !CurrentStatus.length ||
            !CurrentStatus.every(Number.isInteger)
          ) {
            throw new Error('Malformed Phrozen machine status')
          }
          return status
        },
      },
    )
    if (ack !== 0) throw new Error(`Phrozen denied status (Ack ${ack})`)
    return pushed as Record<string, unknown>
  }

  return Object.freeze({
    identity: device,
    authentication: 'none' as const,
    readStatus,
    ...createPhrozenOperations({
      endpoint,
      firmware: device.firmware,
      readStatus,
      confirmTimeoutMs,
      pollMs,
      uploadTimeoutMs,
    }),
  })
}
