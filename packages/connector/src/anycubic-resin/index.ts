import { createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { isIP } from 'node:net'

type Options = { host: string; port?: number; timeoutMs?: number }
const responseLimit = 16_384

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text)
  if (!record(value)) throw new Error('Expected a JSON object')
  return value
}

function md5(value: string) {
  return createHash('md5').update(value).digest('hex')
}

// P1 Max handshake capture and client: https://github.com/HoffmanEngineering/printlog-bridge/tree/8a205eb/src/printlog_bridge/adapters/anycubic
export function createPhotonResinAdapter({
  host,
  port = 18910,
  timeoutMs = 5000,
}: Options) {
  const ipVersion = isIP(host)
  if (
    !ipVersion ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60000
  ) {
    throw new Error('Invalid Photon LAN endpoint')
  }
  const origin = `http://${ipVersion === 6 ? '[' + host + ']' : host}:${port}`

  async function request(path: string, method: 'GET' | 'POST') {
    const signal = AbortSignal.timeout(timeoutMs)
    try {
      const response = await fetch(origin + path, {
        method,
        redirect: 'manual',
        signal,
        ...(method === 'POST' ? { body: '' } : {}),
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error('HTTP rejection')
      }
      if (!response.body) throw new Error('Empty body')
      let size = 0
      const chunks: Buffer[] = []
      const reader = response.body.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > responseLimit) {
            await reader.cancel()
            throw new Error('Oversized reply')
          }
          chunks.push(Buffer.from(value))
        }
      } finally {
        reader.releaseLock()
      }
      try {
        return parseObject(Buffer.concat(chunks).toString('utf8'))
      } catch {
        throw new Error('Invalid JSON reply')
      }
    } catch (error) {
      if (signal.aborted) throw new Error('Photon LAN request timed out')
      if (error instanceof Error && error.message === 'Invalid JSON reply') {
        throw new Error('Malformed Photon LAN reply')
      }
      throw new Error('Photon LAN request failed')
    }
  }

  async function info() {
    const report = await request('/info', 'GET')
    if (
      report.code !== 0 ||
      report.deviceType !== 'lcd' ||
      report.modelId !== '132' ||
      report.modelName !== 'Anycubic Photon P1 Max'
    ) {
      throw new Error('Unsupported Photon LAN identity')
    }
    if (
      typeof report.cn !== 'string' ||
      !/^[A-Za-z0-9-]{1,64}$/.test(report.cn) ||
      typeof report.token !== 'string' ||
      !/^[!-~]{32}$/.test(report.token) ||
      typeof report.ctrlType !== 'string'
    ) {
      throw new Error('Malformed Photon LAN identity')
    }
    return {
      identity: {
        model: report.modelName,
        modelId: report.modelId,
        serial: report.cn,
        mode: report.ctrlType,
      },
      token: report.token,
    }
  }

  return {
    async discover() {
      return (await info()).identity
    },
    async negotiateBroker(expectedSerial: string) {
      const { identity, token } = await info()
      if (identity.serial !== expectedSerial || identity.mode !== 'net') {
        throw new Error('Photon LAN identity or mode mismatch')
      }
      const ts = String(Date.now())
      const nonce = randomBytes(8).toString('hex')
      const sign = md5(md5(token.slice(0, 16)) + ts + nonce)
      const query = new URLSearchParams({
        ts,
        nonce,
        sign,
        did: 'openfarm-connector',
      })
      const reply = await request(`/ctrl?${query}`, 'POST')
      if (reply.code === 19002)
        throw new Error('Photon LAN authentication denied')
      if (
        reply.code !== 200 ||
        !record(reply.data) ||
        typeof reply.data.info !== 'string' ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(reply.data.info) ||
        typeof reply.data.token !== 'string' ||
        !/^[!-~]{16}$/.test(reply.data.token)
      ) {
        throw new Error('Malformed Photon LAN credential reply')
      }

      try {
        const decipher = createDecipheriv(
          'aes-128-cbc',
          token.slice(16),
          reply.data.token,
        )
        decipher.setAutoPadding(false)
        const plaintext = Buffer.concat([
          decipher.update(Buffer.from(reply.data.info, 'base64')),
          decipher.final(),
        ]).toString('utf8')
        // Captures describe NUL padding. Some clients also strip PKCS#7 padding.
        const last = plaintext.charCodeAt(plaintext.length - 1)
        const padding =
          last >= 1 && last <= 16 ? String.fromCharCode(last).repeat(last) : ''
        const credentials = parseObject(
          padding && plaintext.endsWith(padding)
            ? plaintext.slice(0, -last)
            : plaintext.replace(/\0+$/, ''),
        )
        const { broker, deviceId, clientId, username, password } = credentials
        if (
          typeof broker !== 'string' ||
          !broker.endsWith(':8883') ||
          typeof deviceId !== 'string' ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(deviceId) ||
          typeof clientId !== 'string' ||
          !clientId ||
          typeof username !== 'string' ||
          !username ||
          typeof password !== 'string' ||
          !password
        ) {
          throw new Error('Invalid credentials')
        }
        // Keep the configured address. Advertised URLs and hosts are untrusted.
        return { host, port: 8883, deviceId, clientId, username, password }
      } catch {
        throw new Error('Malformed Photon LAN credentials')
      }
    },
  }
}
