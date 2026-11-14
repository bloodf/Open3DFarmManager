export function createMoonrakerSession(input: {
  origin: string
  username: string
  password: string
}) {
  const origin = new URL(input.origin)
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.username ||
    origin.password
  )
    throw new Error('Moonraker authentication failed: 0')
  let token = ''
  let refreshToken = ''
  let expiry = 0
  let pending: Promise<void> | undefined

  async function request(path: string, init: RequestInit = {}) {
    let response: Response
    try {
      response = await fetch(new URL(path, origin), {
        ...init,
        redirect: 'error',
        credentials: 'omit',
      })
    } catch {
      throw new Error('Moonraker authentication failed: 0')
    }
    if (!response.ok)
      throw new Error(`Moonraker authentication failed: ${response.status}`)
    try {
      return (await response.json()).result
    } catch {
      throw new Error('Moonraker authentication failed: 0')
    }
  }

  async function authenticate() {
    const result = refreshToken
      ? await request('/access/refresh_jwt', {
          method: 'POST',
          headers: { Authorization: `Bearer ${refreshToken}` },
        })
      : await request('/access/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: input.username,
            password: input.password,
          }),
        })
    try {
      if (typeof result.token !== 'string' || !result.token) throw 0
      const payload = JSON.parse(
        Buffer.from(result.token.split('.')[1], 'base64url').toString(),
      )
      if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp))
        throw 0
      if (
        !refreshToken &&
        (typeof result.refresh_token !== 'string' || !result.refresh_token)
      )
        throw 0
      token = result.token
      if (typeof result.refresh_token === 'string' && result.refresh_token)
        refreshToken = result.refresh_token
      expiry = payload.exp * 1000
    } catch {
      throw new Error('Moonraker authentication failed: 0')
    }
  }

  async function getAuthHeaders() {
    if (!token || Date.now() >= expiry - 60_000) {
      pending ??= authenticate().finally(() => {
        pending = undefined
      })
      await pending
    }
    return { Authorization: `Bearer ${token}` }
  }
  async function getWebsocketUrl() {
    const headers = await getAuthHeaders()
    const result = await request('/access/oneshot_token', { headers })
    if (typeof result !== 'string' || !result)
      throw new Error('Moonraker authentication failed: 0')
    const url = new URL('/websocket', origin)
    url.protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('token', result)
    return url.toString()
  }
  return { getAuthHeaders, getWebsocketUrl }
}
