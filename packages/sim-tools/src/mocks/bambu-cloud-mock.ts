// SPDX-License-Identifier: MIT
import { randomBytes } from 'node:crypto'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { Socket } from 'node:net'
import { startMqttBroker } from './mqtt-broker.ts'
import { assertLoopbackAddress } from './network-guard.ts'

/**
 * Loopback Bambu cloud: login, token refresh, device list, task history
 * and MQTT broker info. Never dials a real Bambu host.
 */
export interface BambuCloudDevice {
  dev_id: string
  name: string
  dev_model_name: string
  nozzle_diameter: number
}

export interface BambuCloudTask {
  id: string
  title: string
  status: 'success' | 'failed' | 'printing' | 'paused'
  start: number | null
  end: number | null
  weight: number
  filaments: { slot: number; grams: number }[]
}

export interface BambuCloudMockOptions {
  account?: string | undefined
  password?: string | undefined
  emailCode?: string | undefined
  /** When set, a correct password returns a 2FA challenge instead of tokens. */
  tfaCode?: string | null | undefined
  accessToken?: string | undefined
  refreshToken?: string | undefined
  expiresIn?: number | undefined
  devices?: BambuCloudDevice[] | undefined
  tasks?: BambuCloudTask[] | undefined
}

export interface BambuCloudMockInstance {
  origin: string
  mqtt: { host: '127.0.0.1'; port: number; username: string; url: string }
  ports: { http: number; mqtt: number }
  control: {
    setExpiresIn: (seconds: number) => void
    setTfaCode: (code: string | null) => void
  }
  calls: () => Readonly<Record<string, number>>
  close: () => Promise<void>
}

const TOKEN = /^[\x21-\x7E]{16,4096}$/
const USERNAME = 'u_mock'

function send(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 16384) {
        reject(new Error('too-large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function bearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization
  if (typeof header !== 'string') return null
  const match = /^Bearer ([\x21-\x7E]{16,4096})$/.exec(header)
  return match?.[1] ?? null
}

export async function startBambuCloudMock(
  options: BambuCloudMockOptions = {},
): Promise<BambuCloudMockInstance> {
  const account = options.account ?? 'owner@example.com'
  const password = options.password ?? 'owner-password-NEVER-LOG'
  const emailCode = options.emailCode ?? '864209'
  let tfaCode = options.tfaCode ?? null
  let expiresIn = options.expiresIn ?? 3600
  const devices = options.devices ?? [
    {
      dev_id: 'SYNTHETIC',
      name: 'X1C',
      dev_model_name: 'X1C',
      nozzle_diameter: 0.4,
    },
  ]
  const tasks = options.tasks ?? [
    {
      id: 'task-1',
      title: 'Benchy',
      status: 'success' as const,
      start: 1_700_000_000,
      end: 1_700_003_600,
      weight: 12,
      filaments: [{ slot: 0, grams: 12 }],
    },
  ]
  const fixedAccess = options.accessToken
  const fixedRefresh = options.refreshToken
  const sessions = new Map<string, { account: string; refreshToken: string }>()
  const refreshIndex = new Map<string, string>()
  const tfaKeys = new Map<string, string>()
  const calls: Record<string, number> = {}
  const sockets = new Set<Socket>()

  const broker = await startMqttBroker({ reuseSharedTls: true })
  const mqttPort = broker.ports.mqtt

  function issue(owner: string) {
    const accessToken =
      fixedAccess && TOKEN.test(fixedAccess)
        ? fixedAccess
        : `access-${randomBytes(16).toString('hex')}`
    const refreshToken =
      fixedRefresh && TOKEN.test(fixedRefresh)
        ? fixedRefresh
        : `refresh-${randomBytes(16).toString('hex')}`
    sessions.set(accessToken, { account: owner, refreshToken })
    refreshIndex.set(refreshToken, accessToken)
    return { accessToken, refreshToken, expiresIn }
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '/').split('?')[0] ?? '/'
      const method = req.method ?? 'GET'
      const key = `${method} ${path}`
      calls[key] = (calls[key] ?? 0) + 1
      try {
        if (method === 'POST' && path === '/v1/user-service/user/login') {
          const raw = JSON.parse(
            (await readBody(req)).toString('utf8'),
          ) as unknown
          if (typeof raw !== 'object' || raw === null) {
            send(res, 400, { error: 'bad-request' })
            return
          }
          const body = raw as Record<string, unknown>
          if (body.account !== account) {
            send(res, 401, { error: 'unauthorized' })
            return
          }
          if (
            typeof body.tfaKey === 'string' &&
            typeof body.tfaCode === 'string'
          ) {
            if (
              tfaKeys.get(body.tfaKey) === account &&
              body.tfaCode === tfaCode
            ) {
              tfaKeys.delete(body.tfaKey)
              send(res, 200, issue(account))
              return
            }
            send(res, 401, { error: 'unauthorized' })
            return
          }
          if (typeof body.code === 'string' && body.password === undefined) {
            if (body.code === emailCode) {
              send(res, 200, issue(account))
              return
            }
            send(res, 401, { error: 'unauthorized' })
            return
          }
          if (typeof body.password === 'string') {
            if (body.password !== password) {
              send(res, 401, { error: 'unauthorized' })
              return
            }
            if (tfaCode) {
              const tfaKey = `tfa-${randomBytes(16).toString('hex')}`
              tfaKeys.set(tfaKey, account)
              send(res, 200, { loginType: 'tfa', tfaKey })
              return
            }
            send(res, 200, issue(account))
            return
          }
          send(res, 400, { error: 'bad-request' })
          return
        }
        if (
          method === 'POST' &&
          path === '/v1/user-service/user/refreshtoken'
        ) {
          const raw = JSON.parse(
            (await readBody(req)).toString('utf8'),
          ) as unknown
          const refreshToken =
            typeof raw === 'object' && raw && 'refreshToken' in raw
              ? (raw as { refreshToken?: unknown }).refreshToken
              : undefined
          const current =
            typeof refreshToken === 'string'
              ? refreshIndex.get(refreshToken)
              : undefined
          const session = current ? sessions.get(current) : undefined
          if (!current || !session) {
            send(res, 401, { error: 'unauthorized' })
            return
          }
          sessions.delete(current)
          const accessToken = `access-${randomBytes(16).toString('hex')}`
          sessions.set(accessToken, session)
          refreshIndex.set(session.refreshToken, accessToken)
          send(res, 200, {
            accessToken,
            refreshToken: session.refreshToken,
            expiresIn,
          })
          return
        }
        if (method === 'GET') {
          const token = bearer(req)
          if (!token || !sessions.has(token)) {
            send(res, 401, { error: 'unauthorized' })
            return
          }
          if (path === '/v1/iot-service/api/user/bind') {
            send(res, 200, { devices })
            return
          }
          if (path === '/v1/user-service/my/tasks') {
            send(res, 200, { hits: tasks })
            return
          }
          if (path === '/v1/iot-service/api/user/mqtt') {
            send(res, 200, {
              host: '127.0.0.1',
              port: mqttPort,
              username: USERNAME,
              url: `mqtts://127.0.0.1:${mqttPort}`,
              passwordIsAccessToken: true,
            })
            return
          }
        }
        send(res, 404, { error: 'not-found' })
      } catch {
        if (!res.writableEnded) send(res, 400, { error: 'bad-request' })
      }
    })()
  })

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const addr = server.address()
  assertLoopbackAddress(addr)
  if (!addr || typeof addr === 'string')
    throw new Error('Failed to obtain Bambu cloud mock address')
  const origin = `http://127.0.0.1:${addr.port}`

  return {
    origin,
    mqtt: {
      host: '127.0.0.1',
      port: mqttPort,
      username: USERNAME,
      url: `mqtts://127.0.0.1:${mqttPort}`,
    },
    ports: { http: addr.port, mqtt: mqttPort },
    control: {
      setExpiresIn: (seconds) => {
        expiresIn = seconds
      },
      setTfaCode: (code) => {
        tfaCode = code
      },
    },
    calls: () => ({ ...calls }),
    close: async () => {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await broker.close()
    },
  }
}
