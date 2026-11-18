import { createSocket } from 'node:dgram'
import { isIPv4 } from 'node:net'
import { createDecipheriv } from 'node:crypto'

export function isLocalAddress(address: string) {
  return (
    isIPv4(address) &&
    /^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(
      address,
    )
  )
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {}
}

async function request(
  address: string,
  port: number,
  path: string,
  method: string,
) {
  if (!isLocalAddress(address))
    throw new Error('Kobra X requires a local IPv4 address')
  const response = await fetch(new URL(path, `http://${address}:${port}`), {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(2500),
  })
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Empty Kobra X response')
  try {
    if (!response.ok) throw new Error('Kobra X HTTP request failed')
    const chunks = []
    let size = 0
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return record(JSON.parse(Buffer.concat(chunks).toString()))
      size += value.length
      if (size > 16384) throw new Error('Kobra X response exceeded size limit')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}

export async function readKobraXInfo(address: string, port = 18910) {
  const info = await request(address, port, '/info', 'GET')
  if (
    info.ctrlType !== 'lan' ||
    info.modelId !== '20030' ||
    typeof info.token !== 'string' ||
    info.token.length !== 32
  ) {
    throw new Error('Kobra X LAN identity could not be confirmed')
  }
  return {
    address,
    token: info.token,
    name:
      typeof info.deviceName === 'string' && info.deviceName
        ? info.deviceName.slice(0, 64)
        : 'Anycubic Kobra X',
  }
}

export async function discoverKobraX(
  options: {
    target?: string
    ssdpPort?: number
    httpPort?: number
    timeoutMs?: number
  } = {},
) {
  const target = options.target ?? '239.255.255.250'
  if (target !== '239.255.255.250' && !isLocalAddress(target))
    throw new Error('Invalid SSDP target')
  const candidates = await new Promise<Set<string>>((resolve, reject) => {
    const socket = createSocket('udp4')
    const addresses = new Set<string>()
    let replies = 0
    let finished = false
    const timer = setTimeout(finish, options.timeoutMs ?? 2500)
    function finish(error?: Error) {
      if (finished) return
      finished = true
      clearTimeout(timer)
      socket.close()
      if (error) reject(error)
      else resolve(addresses)
    }
    const port = options.ssdpPort ?? 1900
    socket.once('error', finish)
    socket.on('message', (message, sender) => {
      replies++
      if (
        message.length <= 2048 &&
        sender.port === port &&
        isLocalAddress(sender.address) &&
        (!message.length || /ac:3dprinter|:18910\//i.test(message.toString()))
      )
        addresses.add(sender.address)
      if (replies >= 64 || addresses.size >= 4) finish()
    })
    socket.bind(0, target.startsWith('127.') ? '127.0.0.1' : '0.0.0.0', () =>
      socket.send(
        'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ac:3dprinter:20030\r\n\r\n',
        port,
        target,
        (error) => {
          if (error) finish(error)
        },
      ),
    )
  })
  const confirmed = await Promise.allSettled(
    [...candidates].map((address) => readKobraXInfo(address, options.httpPort)),
  )
  return confirmed.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  )
}

// The clean-room spec requires verified signing and key/IV derivation before
// enabling recovery on hardware. The simulator supplies its own protocol.
export interface KobraXRecoveryProtocol {
  query(token: string): { ts: string; nonce: string; sign: string; did: string }
  encrypted(
    token: string,
    response: Record<string, unknown>,
  ): { key: Buffer; iv: Buffer; ciphertext: Buffer }
}

export async function recoverKobraXCredentials(
  info: Awaited<ReturnType<typeof readKobraXInfo>>,
  protocol: KobraXRecoveryProtocol,
  port = 18910,
) {
  try {
    const query = new URLSearchParams(protocol.query(info.token))
    const response = await request(info.address, port, `/ctrl?${query}`, 'POST')
    const { key, iv, ciphertext } = protocol.encrypted(info.token, response)
    const decipher = createDecipheriv('aes-128-cbc', key, iv)
    const { username, password, modeId, deviceId } = record(
      JSON.parse(
        Buffer.concat([
          decipher.update(ciphertext),
          decipher.final(),
        ]).toString(),
      ),
    )
    if (
      typeof username !== 'string' ||
      !username ||
      typeof password !== 'string' ||
      !password ||
      typeof modeId !== 'string' ||
      !/^[\w-]{1,128}$/.test(modeId) ||
      typeof deviceId !== 'string' ||
      !/^[\w-]{1,128}$/.test(deviceId)
    )
      throw new Error()
    return { username, password, modeId, deviceId }
  } catch {
    throw new Error('Kobra X credential recovery failed')
  }
}
