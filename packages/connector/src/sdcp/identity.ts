import dgram from 'node:dgram'
import { isIPv4 } from 'node:net'
import { sdcpModelKey, sdcpProfile } from './models.ts'

export type SdcpTarget = Readonly<{
  host: string
  brandId: string
  mainboardId: string
  model: string
  firmwareVersion: string
}>

/**
 * Discovery reply of a controllable model. Resin boards must name protocol
 * V3.0.0 and their own address (CBD spec, "Device Discovery Description").
 * The Centauri Carbon omits both (bjan/pycentauri @ 2f6d9ed,
 * docs/PROTOCOL.md "Discovery"); whatever it does send must still match.
 */
export function parseSdcpControlDiscovery(
  packet: Buffer,
  sender: string,
): SdcpTarget | undefined {
  if (packet.length > 8192 || !isIPv4(sender)) return
  try {
    const message = JSON.parse(packet.toString())
    const data = message.Data
    const id = /^[A-Za-z0-9_-]{1,64}$/
    if (
      typeof message.Id !== 'string' ||
      !id.test(message.Id) ||
      !data ||
      typeof data !== 'object' ||
      typeof data.MainboardID !== 'string' ||
      !id.test(data.MainboardID) ||
      typeof data.MachineName !== 'string' ||
      typeof data.FirmwareVersion !== 'string' ||
      !/^[\x20-\x7e]{1,64}$/.test(data.FirmwareVersion)
    )
      return
    const profile = sdcpProfile(data.MachineName)
    if (!profile) return
    const optional = profile.family === 'fdm'
    if (
      !(optional && data.MainboardIP === undefined) &&
      data.MainboardIP !== sender
    )
      return
    if (
      !(optional && data.ProtocolVersion === undefined) &&
      !/^V?3\.0\.0$/i.test(String(data.ProtocolVersion))
    )
      return
    return {
      host: sender,
      brandId: message.Id,
      mainboardId: data.MainboardID,
      model: data.MachineName,
      firmwareVersion: data.FirmwareVersion,
    }
  } catch {
    return
  }
}

/**
 * Unicast `M99999` to the provisioned address and accept only the reply that
 * matches the provisioned board and model. Rejects otherwise, so no command or
 * upload ever follows an identity that changed behind the address.
 */
export function resolveSdcpTarget(
  expected: { host: string; mainboardId: string; model: string },
  options: { port?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<SdcpTarget> {
  if (!isIPv4(expected.host)) throw new Error('Invalid SDCP address')
  const socket = dgram.createSocket('udp4')
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs ?? 1000),
    ...(options.signal ? [options.signal] : []),
  ])
  return new Promise<SdcpTarget>((resolve, reject) => {
    let done = false
    function finish(target?: SdcpTarget) {
      if (done) return
      done = true
      signal.removeEventListener('abort', abort)
      socket.close()
      if (target) resolve(target)
      else reject(new Error('SDCP identity mismatch or unavailable'))
    }
    const abort = () => finish()
    if (signal.aborted) return finish()
    signal.addEventListener('abort', abort, { once: true })
    socket.on('error', abort)
    socket.on('message', (packet, peer) => {
      if (peer.address !== expected.host) return
      const target = parseSdcpControlDiscovery(packet, peer.address)
      if (
        target &&
        target.mainboardId === expected.mainboardId &&
        sdcpModelKey(target.model) === sdcpModelKey(expected.model)
      )
        finish(target)
    })
    socket.send('M99999', options.port ?? 3000, expected.host, (error) => {
      if (error) finish()
    })
  })
}
