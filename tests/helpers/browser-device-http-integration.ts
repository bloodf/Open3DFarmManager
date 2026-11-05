import { login } from '../../apps/farm/server/services/authenticated-session.ts'
import {
  browserDeviceRequest,
  type BrowserDeviceHttpRuntime,
  type BrowserDeviceOperation,
} from '../../apps/farm/server/services/browser-devices.ts'
import { hashPassword } from '../../apps/farm/server/utils/auth/password.ts'
import {
  SESSION_COOKIE_ATTRIBUTES,
  SESSION_COOKIE_NAME,
} from '../../apps/farm/server/utils/auth/boundary.ts'
import { MemorySessionRepository } from './memory-session-repository.ts'

/** Synthetic session/registry storage. The maintained login, sealed cookie and HTTP service remain real. */
export async function browserDeviceFixture() {
  const now = Date.now(),
    passwordHash = await hashPassword('synthetic-test-password')
  const sessions = new MemorySessionRepository(
    [{ id: 'account', sessionVersion: 0, disabled: false }],
    [
      {
        id: 'session_one',
        accountId: 'account',
        accountVersion: 0,
        createdAt: now,
        lastSeenAt: now,
        absoluteExpiresAt: now + 60000,
        revokedAt: null,
      },
    ],
  )
  const limits: string[] = [],
    requests: unknown[] = []
  const runtime: BrowserDeviceHttpRuntime = {
    auth: {
      origin: 'https://farm.example.invalid',
      cookie: {
        name: SESSION_COOKIE_NAME,
        password: 'synthetic-cookie-key-never-used-outside-tests',
        maxAge: 60,
        cookie: { ...SESSION_COOKIE_ATTRIBUTES },
      },
      sessions,
      idleTimeoutMs: 60000,
      lifetimeMs: 60000,
      credentials: {
        async consumeLimit(_kind, key) {
          limits.push(key)
          return true
        },
        async find() {
          return {
            accountId: 'account',
            passwordHash,
            credentialVersion: '0',
            sessionVersion: '0',
          }
        },
        async issue() {
          return 'session_one'
        },
      },
    },
    registry: {
      async list(input) {
        requests.push(input)
        return { ok: false, reason: 'denied' }
      },
      async issueChallenge(input) {
        requests.push(input)
        return { ok: false, reason: 'denied' }
      },
      async completeProof(input) {
        requests.push(input)
        return { ok: false, reason: 'denied' }
      },
      async approve(input) {
        requests.push(input)
        return { ok: false, reason: 'denied' }
      },
      async revoke(input) {
        requests.push(input)
        return { ok: false, reason: 'denied' }
      },
    },
    admission: { active: 0 },
  }
  function event(
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body?: BodyInit,
  ) {
    return {
      req: new Request('https://farm.example.invalid' + path, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
      }),
      res: { status: 200, statusText: 'OK', headers: new Headers() },
    }
  }
  const authEvent = event(
    'POST',
    '/api/auth/login',
    { origin: runtime.auth.origin, 'content-type': 'application/json' },
    JSON.stringify({
      username: 'fixture_user',
      password: 'synthetic-test-password',
    }),
  )
  await login(authEvent, runtime.auth)
  const cookieValue = authEvent.res.headers.getSetCookie()[0]?.split(';')[0]
  if (!cookieValue) throw new Error('Missing sealed fixture cookie')
  const cookie: string = cookieValue
  limits.length = 0
  function call(
    operation: BrowserDeviceOperation,
    path: string,
    body?: BodyInit,
    headers: Record<string, string> = {},
    method = operation === 'list' ? 'GET' : 'POST',
  ) {
    return browserDeviceRequest(
      event(
        method,
        path,
        {
          cookie,
          ...(method === 'POST'
            ? {
                origin: runtime.auth.origin,
                'content-type': 'application/json',
              }
            : {}),
          ...headers,
        },
        body,
      ),
      runtime,
      operation,
    )
  }
  return { runtime, sessions, limits, requests, event, call, cookie }
}
