import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createMoonrakerSession } from '../../packages/connector/src/moonraker/auth.ts'

const jwt = (exp: number) =>
  `e30.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.signature`

test('login, refresh, expired refresh, bad password and oneshot', async () => {
  let logins = 0
  let refreshes = 0
  let expired = false
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    res.setHeader('content-type', 'application/json')
    if (req.url === '/access/login') {
      logins++
      if (JSON.parse(body).password !== 'correct') {
        res.writeHead(401).end('{}')
        return
      }
      res.end(
        JSON.stringify({
          result: {
            token: jwt(Date.now() / 1000 + 30),
            refresh_token: 'refresh',
          },
        }),
      )
    } else if (req.url === '/access/refresh_jwt') {
      refreshes++
      assert.equal(req.headers.authorization, 'Bearer refresh')
      if (expired) {
        res.writeHead(401).end('{}')
        return
      }
      res.end(
        JSON.stringify({ result: { token: jwt(Date.now() / 1000 + 3600) } }),
      )
    } else {
      assert.equal(req.url, '/access/oneshot_token')
      assert.ok(req.headers.authorization?.startsWith('Bearer '))
      res.end(JSON.stringify({ result: 'one shot' }))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
    const session = createMoonrakerSession({
      origin,
      username: 'user',
      password: 'correct',
    })
    assert.match((await session.getAuthHeaders()).Authorization, /^Bearer /)
    assert.equal(
      new URL(await session.getWebsocketUrl()).searchParams.get('token'),
      'one shot',
    )
    assert.equal(logins, 1)
    assert.equal(refreshes, 1)
    const bad = createMoonrakerSession({
      origin,
      username: 'user',
      password: 'wrong',
    })
    await assert.rejects(bad.getAuthHeaders(), /401/)
    const stale = createMoonrakerSession({
      origin,
      username: 'user',
      password: 'correct',
    })
    await stale.getAuthHeaders()
    expired = true
    await assert.rejects(stale.getAuthHeaders(), /401/)
  } finally {
    server.close()
  }
})
