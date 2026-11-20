import {
  isBambuCloudEnabled,
  resolveBambuCloudEndpoint,
} from '../../../../../packages/connector/src/bambu/cloud.ts'

const MAX_BODY = 65536
const TOKEN = /^[\x21-\x7E]{16,4096}$/
const TFA_KEY = /^[\x21-\x7E]{8,200}$/

export type BambuCloudMqtt = {
  host: '127.0.0.1' | 'localhost'
  port: number
  username: string
}

export type BambuCloudLogin =
  | {
      ok: true
      kind: 'tfa'
      tfaKey: string
    }
  | {
      ok: true
      kind: 'tokens'
      accessToken: string
      refreshToken: string | null
      expiresAt: Date
      mqtt: BambuCloudMqtt | null
    }
  | {
      ok: false
      reason: 'cloud-disabled' | 'cloud-rejected' | 'cloud-unauthorized'
    }

export type BambuCloudLoginBody = {
  account: string
  code?: string | undefined
  password?: string | undefined
  tfaKey?: string | undefined
  tfaCode?: string | undefined
}

function endpointUrl(endpoint: string, policy: unknown): URL | null {
  try {
    const url = resolveBambuCloudEndpoint(endpoint, policy)
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      return null
    return url
  } catch {
    return null
  }
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null
  return value as Record<string, unknown>
}

async function readJson(response: Response): Promise<unknown | null> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY) return null
  const text = await response.text()
  if (text.length > MAX_BODY) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

async function callCloud(
  url: URL,
  method: 'GET' | 'POST',
  fetchImpl: typeof fetch,
  token: string | null,
  body: unknown,
): Promise<{ status: number; json: unknown } | null> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (body !== null) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  try {
    const response = await fetchImpl(url, {
      method,
      headers,
      body: body === null ? null : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(3000),
    })
    const json = await readJson(response)
    if (json === null) return null
    return { status: response.status, json }
  } catch {
    return null
  }
}

function mqttFrom(value: unknown): BambuCloudMqtt | null {
  const body = record(value)
  if (!body) return null
  const host = body.host
  const port = body.port
  const username = body.username
  if (host !== '127.0.0.1' && host !== 'localhost') return null
  if (
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    return null
  if (typeof username !== 'string' || !/^[\x21-\x7E]{1,128}$/.test(username))
    return null
  return { host, port, username }
}

export async function loginBambuCloud(input: {
  endpoint: string
  policy: unknown
  body: BambuCloudLoginBody
  now: Date
  fetchImpl?: typeof fetch | undefined
}): Promise<BambuCloudLogin> {
  if (!isBambuCloudEnabled(input.policy))
    return { ok: false, reason: 'cloud-disabled' }
  const base = endpointUrl(input.endpoint, input.policy)
  if (!base) return { ok: false, reason: 'cloud-rejected' }
  const fetchImpl = input.fetchImpl ?? fetch
  const payload: Record<string, string> = { account: input.body.account }
  if (input.body.code) payload.code = input.body.code
  if (input.body.password) payload.password = input.body.password
  if (input.body.tfaKey) payload.tfaKey = input.body.tfaKey
  if (input.body.tfaCode) payload.tfaCode = input.body.tfaCode
  const login = await callCloud(
    new URL('/v1/user-service/user/login', base),
    'POST',
    fetchImpl,
    null,
    payload,
  )
  if (!login) return { ok: false, reason: 'cloud-rejected' }
  if (login.status === 401 || login.status === 403)
    return { ok: false, reason: 'cloud-unauthorized' }
  if (login.status !== 200) return { ok: false, reason: 'cloud-rejected' }
  const body = record(login.json)
  if (!body) return { ok: false, reason: 'cloud-rejected' }
  if (body.loginType === 'tfa') {
    if (typeof body.tfaKey !== 'string' || !TFA_KEY.test(body.tfaKey))
      return { ok: false, reason: 'cloud-rejected' }
    return { ok: true, kind: 'tfa', tfaKey: body.tfaKey }
  }
  if (
    typeof body.accessToken !== 'string' ||
    !TOKEN.test(body.accessToken) ||
    typeof body.expiresIn !== 'number' ||
    !Number.isInteger(body.expiresIn) ||
    body.expiresIn < -366 * 86400 ||
    body.expiresIn > 400 * 86400
  )
    return { ok: false, reason: 'cloud-rejected' }
  const refreshToken =
    body.refreshToken === undefined || body.refreshToken === null
      ? null
      : typeof body.refreshToken === 'string' && TOKEN.test(body.refreshToken)
        ? body.refreshToken
        : undefined
  if (refreshToken === undefined) return { ok: false, reason: 'cloud-rejected' }
  const mqttCall = await callCloud(
    new URL('/v1/iot-service/api/user/mqtt', base),
    'GET',
    fetchImpl,
    body.accessToken,
    null,
  )
  const mqtt =
    mqttCall && mqttCall.status === 200 ? mqttFrom(mqttCall.json) : null
  return {
    ok: true,
    kind: 'tokens',
    accessToken: body.accessToken,
    refreshToken,
    expiresAt: new Date(input.now.getTime() + body.expiresIn * 1000),
    mqtt,
  }
}
