import { createSocket } from 'node:dgram'
import { isIPv4 } from 'node:net'
import { createDecipheriv, createHash, randomInt } from 'node:crypto'

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
  signal?: AbortSignal,
) {
  if (!isLocalAddress(address))
    throw new Error('Kobra X requires a local IPv4 address')
  const response = await fetch(new URL(path, `http://${address}:${port}`), {
    method,
    headers: method === 'POST' ? { Connection: 'close' } : {},
    redirect: 'error',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(2500)])
      : AbortSignal.timeout(2500),
  })
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Empty Kobra X response')
  try {
    if (response.status !== 200) throw new Error('Kobra X HTTP request failed')
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

export async function readKobraXInfo(
  address: string,
  port = 18910,
  signal?: AbortSignal,
) {
  const info = await request(address, port, '/info', 'GET', signal)
  if (
    info.ctrlType !== 'lan' ||
    info.modelId !== '20030' ||
    typeof info.token !== 'string' ||
    !/^[\x20-\x7e]{32}$/.test(info.token)
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

export function kobraXCtrlQuery(token: string, ts: string, nonce: string) {
  const md5 = (value: string) =>
    createHash('md5').update(value, 'ascii').digest('hex')
  return new URLSearchParams({
    ts,
    nonce,
    sign: md5(md5(token.slice(0, 16)) + ts + nonce),
    did: 'random',
  })
}

export async function recoverKobraXCredentials(
  info: Awaited<ReturnType<typeof readKobraXInfo>>,
  port = 18910,
  signal?: AbortSignal,
) {
  try {
    if (!/^[\x20-\x7e]{32}$/.test(info.token)) throw new Error()
    const alphabet =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    const nonce = Array.from({ length: 6 }, () =>
      alphabet.charAt(randomInt(alphabet.length)),
    ).join('')
    const query = kobraXCtrlQuery(info.token, String(Date.now()), nonce)
    const response = await request(
      info.address,
      port,
      '/ctrl?' + query,
      'POST',
      signal,
    )
    const { token: iv, info: encoded } = record(response.data)
    if (
      response.code !== 200 ||
      typeof iv !== 'string' ||
      !/^[\x20-\x7e]{16}$/.test(iv) ||
      typeof encoded !== 'string'
    )
      throw new Error()

    const ciphertext = Buffer.from(encoded, 'base64')
    if (
      !ciphertext.length ||
      ciphertext.length % 16 ||
      ciphertext.toString('base64') !== encoded
    )
      throw new Error()

    const decipher = createDecipheriv('aes-128-cbc', info.token.slice(16), iv)
    const plaintext = new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat([decipher.update(ciphertext), decipher.final()]),
    )
    const {
      username,
      password,
      modeId = '20030',
      deviceId,
      error,
    } = record(JSON.parse(plaintext))
    if (
      (error !== undefined && error !== '') ||
      typeof username !== 'string' ||
      !username.trim() ||
      username.includes('\0') ||
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
