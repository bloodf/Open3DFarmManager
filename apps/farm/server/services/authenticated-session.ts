import { parseBoundedJson } from '@open3dfarmmanager/farm-protocol'
import {
  createError,
  getCookie,
  getRequestIP,
  useSession,
  type RequestEvent,
} from 'nuxt/server'
import {
  checkMutationOrigin,
  SESSION_COOKIE_NAME,
} from '../utils/auth/boundary.ts'
import {
  DUMMY_PASSWORD_HASH,
  PasswordCapacityError,
  verifyPassword,
} from '../utils/auth/password.ts'
import type { AuthRuntime } from '../utils/auth/runtime.ts'

type AuthEvent = Pick<RequestEvent, 'req' | 'res'>

const unavailable = () =>
  createError({
    status: 503,
    message: 'Autenticação indisponível. Tente novamente.',
  })
const unauthorized = () =>
  createError({ status: 401, message: 'Usuário ou senha inválidos.' })
export function authResponse(event: AuthEvent): void {
  event.res.headers.set('Cache-Control', 'no-store')
  event.res.headers.set('Pragma', 'no-cache')
}
function mutation(event: AuthEvent, runtime: AuthRuntime): void {
  authResponse(event)
  if (!checkMutationOrigin(event.req.headers.get('origin'), runtime.origin).ok)
    throw createError({
      status: 403,
      message: 'Origem da solicitação não permitida.',
    })
}
export async function readLoginBody(
  request: Request,
): Promise<{ username: string; password: string }> {
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim() !==
      'application/json' ||
    request.headers.has('content-encoding')
  )
    throw createError({ status: 415, message: 'Envie os dados em JSON.' })
  const reader = request.body?.getReader()
  if (!reader)
    throw createError({ status: 400, message: 'Dados de acesso inválidos.' })
  const chunks: Uint8Array[] = []
  let size = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          createError({ status: 408, message: 'Tempo de envio esgotado.' }),
        )
        void reader.cancel().catch(() => {})
      }, 5000)
    })
    while (true) {
      const chunk = await Promise.race([reader.read(), timeout])
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 4096)
        throw createError({ status: 413, message: 'Solicitação muito grande.' })
      chunks.push(chunk.value)
    }
    const data = parseBoundedJson(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
      { maxBytes: 4096, maxDepth: 2, maxValues: 3, maxStringChars: 1024 },
    )
    if (
      typeof data !== 'object' ||
      data === null ||
      Object.keys(data).length !== 2 ||
      !('username' in data) ||
      !('password' in data) ||
      typeof data.username !== 'string' ||
      typeof data.password !== 'string' ||
      !/^[a-z0-9_-]{3,64}$/.test(data.username) ||
      data.password.length < 1 ||
      data.password.includes('\0') ||
      Buffer.byteLength(data.password) > 1024
    )
      throw new Error('Invalid credentials input')
    return { username: data.username, password: data.password }
  } catch (error) {
    if (error instanceof Error && 'status' in error) throw error
    throw createError({ status: 400, message: 'Dados de acesso inválidos.' })
  } finally {
    clearTimeout(timer)
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
async function limit(
  runtime: AuthRuntime,
  kind: 'a' | 's',
  key: string,
): Promise<void> {
  let allowed: boolean
  try {
    allowed = await runtime.credentials.consumeLimit(kind, key)
  } catch {
    throw unavailable()
  }
  if (!allowed)
    throw createError({
      status: 429,
      message: 'Muitas tentativas. Aguarde 15 minutos.',
    })
}
export async function login(
  event: AuthEvent,
  runtime: AuthRuntime,
): Promise<{ accountId: string }> {
  mutation(event, runtime)
  // Absence of transport address shares one restrictive bucket; forwarded headers are ignored.
  await limit(
    runtime,
    's',
    getRequestIP(event, { xForwardedFor: false }) ?? 'unknown-source',
  )
  const input = await readLoginBody(event.req)
  await limit(runtime, 'a', input.username)
  let snapshot
  let valid: boolean
  try {
    snapshot = await runtime.credentials.find(input.username)
    valid = await verifyPassword(
      snapshot?.passwordHash ?? DUMMY_PASSWORD_HASH,
      input.password,
    )
  } catch (error) {
    if (error instanceof PasswordCapacityError)
      throw createError({
        status: 429,
        message: 'Muitas tentativas. Tente novamente.',
      })
    throw unavailable()
  }
  if (!valid || !snapshot) throw unauthorized()
  let sessionId: string | null
  try {
    sessionId = await runtime.credentials.issue(
      snapshot,
      Date.now(),
      runtime.lifetimeMs,
    )
  } catch {
    throw unavailable()
  }
  if (!sessionId) throw unauthorized()
  try {
    const cookie = await useSession(event, runtime.cookie)
    const oldId = cookie.data.sessionRecordId
    if (typeof oldId === 'string')
      await runtime.sessions.revokeSession(oldId, Date.now())
    await cookie.clear()
    await cookie.update({ sessionRecordId: sessionId })
  } catch {
    // A committed but unissued session cannot authenticate without its sealed cookie.
    await runtime.sessions.revokeSession(sessionId, Date.now()).catch(() => {})
    throw unavailable()
  }
  return { accountId: snapshot.accountId }
}
/** Reads only the sealed host-only cookie. Callers must authorize the ID in their transaction. */
export async function sealedSessionRecordId(
  event: AuthEvent,
  runtime: Pick<AuthRuntime, 'cookie'>,
): Promise<string> {
  authResponse(event)
  // Nitro aliases getCookie to an h3 Node event reader. Upgrade authentication
  // supplies a portable Request; useSession remains responsible for unsealing.
  const prefix = SESSION_COOKIE_NAME + '='
  const hasSessionCookie = event.req.headers
    .get('cookie')
    ?.split(';')
    .some((part: string) => {
      const value = part.trim()
      return value.startsWith(prefix) && value.length > prefix.length
    })
  if (!hasSessionCookie) throw unauthorized()
  const cookie = await useSession(event, runtime.cookie)
  const id = cookie.data.sessionRecordId
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id))
    throw unauthorized()
  return id
}
export async function authenticatedSession(
  event: AuthEvent,
  runtime: AuthRuntime,
): Promise<{ accountId: string }> {
  authResponse(event)
  if (!getCookie(event, SESSION_COOKIE_NAME)) throw unauthorized()
  const cookie = await useSession(event, runtime.cookie)
  const id = cookie.data.sessionRecordId
  if (typeof id !== 'string') throw unauthorized()
  const decision = await runtime.sessions.authorizeAndTouch(id, Date.now(), {
    idleTimeoutMs: runtime.idleTimeoutMs,
  })
  if (!decision.ok) {
    if (decision.reason === 'storage-unavailable') throw unavailable()
    throw unauthorized()
  }
  return { accountId: decision.accountId }
}
export async function logout(
  event: AuthEvent,
  runtime: AuthRuntime,
): Promise<{ loggedOut: true }> {
  mutation(event, runtime)
  if (!getCookie(event, SESSION_COOKIE_NAME)) return { loggedOut: true }
  const cookie = await useSession(event, runtime.cookie)
  const id = cookie.data.sessionRecordId
  try {
    if (typeof id === 'string')
      await runtime.sessions.revokeSession(id, Date.now())
    await cookie.clear()
  } catch {
    throw unavailable()
  }
  return { loggedOut: true }
}
