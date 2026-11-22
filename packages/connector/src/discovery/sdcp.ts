import dgram from 'node:dgram'
import { isIPv4 } from 'node:net'

export type SdcpIdentity = {
  host: string
  mainboardId: string
  model: string
  protocolVersion: string
  firmwareVersion: string
  name: string
}
const models = new Set(['saturn 4 ultra', 'saturn 4 ultra 16k', 'mars 5 ultra'])

export function isSupportedSdcpModel(model: string): boolean {
  return models.has(model.replace(/^elegoo\s+/i, '').toLowerCase())
}

export function parseSdcpDiscovery(
  packet: Buffer,
  sender: string,
): SdcpIdentity | undefined {
  if (packet.length > 8192 || !isIPv4(sender)) return
  try {
    const data = JSON.parse(packet.toString()).Data
    if (
      !data ||
      typeof data !== 'object' ||
      data.MainboardIP !== sender ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(data.MainboardID) ||
      typeof data.MachineName !== 'string' ||
      !models.has(data.MachineName.replace(/^elegoo\s+/i, '').toLowerCase()) ||
      typeof data.ProtocolVersion !== 'string' ||
      typeof data.FirmwareVersion !== 'string' ||
      typeof data.Name !== 'string' ||
      data.Name.length > 128
    )
      return
    return {
      host: sender,
      mainboardId: data.MainboardID,
      model: data.MachineName,
      protocolVersion: data.ProtocolVersion,
      firmwareVersion: data.FirmwareVersion,
      name: data.Name,
    }
  } catch {
    return
  }
}

export async function discoverSdcp(
  options: { target?: string; port?: number; timeoutMs?: number } = {},
): Promise<SdcpIdentity[]> {
  const socket = dgram.createSocket('udp4')
  const found = new Map<string, SdcpIdentity>()
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject)
      socket.bind(0, () => {
        socket.setBroadcast(true)
        resolve()
      })
    })
    socket.on('message', (packet, peer) => {
      const identity = parseSdcpDiscovery(packet, peer.address)
      if (identity && found.size < 128)
        found.set(identity.mainboardId, identity)
    })
    await new Promise<void>((resolve, reject) =>
      socket.send(
        'M99999',
        options.port ?? 3000,
        options.target ?? '255.255.255.255',
        (error) => (error ? reject(error) : resolve()),
      ),
    )
    await new Promise((resolve) =>
      setTimeout(resolve, options.timeoutMs ?? 1000),
    )
    return [...found.values()]
  } finally {
    socket.close()
  }
}
