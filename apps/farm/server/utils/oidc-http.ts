import { randomBytes } from 'node:crypto'
import {
  createError,
  getRequestIP,
  useRuntimeConfig,
  useSession,
  type RequestEvent,
} from 'nuxt/server'
import { resetTokenDigest } from '../services/password-reset.ts'
import {
  authResponse,
  establishSession,
  limit,
  mutation,
} from '../services/authenticated-session.ts'
import { hashPassword, PasswordCapacityError } from './auth/password.ts'
import { SESSION_COOKIE_ATTRIBUTES } from './auth/boundary.ts'
import { authRuntime, type AuthRuntime } from './auth/runtime.ts'
import { oidcConfiguration } from './oidc-client.ts'
import { readOidcConfig, type OidcSettings } from './oidc-config.ts'
import {
  beginOidcAuthorization,
  decideOidcAccount,
  finishOidcAuthorization,
  oidcCallbackUrl,
  type OidcDirectory,
} from './oidc-login.ts'

const OIDC_COOKIE = '__Host-open3dfarmmanager-oidc'
const TRANSACTION_MS = 10 * 60 * 1000
const usernamePattern = /^[a-z0-9_-]{3,64}$/

type AuthEvent = Pick<RequestEvent, 'req' | 'res'>
const unavailable = () =>
  createError({ status: 503, message: 'Autenticação indisponível.' })
const refused = () =>
  createError({
    status: 400,
    message: 'Não foi possível iniciar o acesso pelo provedor.',
  })

function settingsOrThrow(): OidcSettings {
  const result = readOidcConfig(useRuntimeConfig().auth)
  if (result.state === 'off')
    throw createError({ status: 404, message: 'Recurso indisponível.' })
  if (result.state === 'invalid') throw unavailable()
  return result.settings
}

function redirect(event: AuthEvent, location: string): void {
  authResponse(event)
  event.res.headers.set('Referrer-Policy', 'no-referrer')
  event.res.status = 303
  event.res.headers.set('location', location)
}

async function transactionCookie(event: AuthEvent, runtime: AuthRuntime) {
  return await useSession(event, {
    name: OIDC_COOKIE,
    password: runtime.cookie.password,
    maxAge: TRANSACTION_MS / 1000,
    cookie: { ...SESSION_COOKIE_ATTRIBUTES },
  })
}

function directory(runtime: AuthRuntime): OidcDirectory {
  const store = runtime.oidc
  if (!store) throw unavailable()
  return {
    findLink: (issuer, subject) => store.findLink(issuer, subject),
    async linkThroughInvite(input) {
      const passwordHash = await hashPassword(
        randomBytes(32).toString('base64url'),
      )
      return await store.linkThroughInvite({ ...input, passwordHash })
    },
  }
}

export function oidcStatus(event: AuthEvent): { enabled: true } {
  authResponse(event)
  settingsOrThrow()
  return { enabled: true }
}

async function start(
  event: AuthEvent,
  pending: { username?: string; inviteDigest?: string },
): Promise<URL> {
  const settings = settingsOrThrow()
  const runtime = authRuntime()
  await limit(
    runtime,
    's',
    'oidc:' +
      (getRequestIP(event, { xForwardedFor: false }) ?? 'unknown-source'),
  )
  const config = await oidcConfiguration(settings).catch(() => {
    throw unavailable()
  })
  const begun = await beginOidcAuthorization(config, settings.redirectUri)
  const cookie = await transactionCookie(event, runtime)
  await cookie.update({
    state: begun.state,
    nonce: begun.nonce,
    verifier: begun.codeVerifier,
    expiresAt: Date.now() + TRANSACTION_MS,
    ...(pending.inviteDigest ? { inviteDigest: pending.inviteDigest } : {}),
    ...(pending.username ? { username: pending.username } : {}),
  })
  return begun.url
}

/** Navigation start. Query strings are refused so an invite cannot sit in the URL. */
export async function oidcStartGet(event: AuthEvent): Promise<void> {
  const settings = settingsOrThrow()
  if (new URL(event.req.url, settings.redirectUri).search) throw refused()
  redirect(event, (await start(event, {})).href)
}

/** Invite linking. The token stays in a header; the sealed cookie keeps only its digest. */
export async function oidcStartPost(
  event: AuthEvent,
): Promise<{ url: string }> {
  settingsOrThrow()
  const runtime = authRuntime()
  mutation(event, runtime)
  const header = event.req.headers.get('x-invite-token')
  let inviteDigest: string | undefined
  let username: string | undefined
  if (header !== null) {
    try {
      inviteDigest = resetTokenDigest(header)
    } catch {
      throw refused()
    }
    username = await readUsername(event.req)
    if (!username) throw refused()
  }
  return { url: (await start(event, { username, inviteDigest })).href }
}

export async function oidcCallback(event: AuthEvent): Promise<void> {
  const settings = settingsOrThrow()
  const fail = settings.origin + '/entrar#erro=oidc'
  let runtime: AuthRuntime
  try {
    runtime = authRuntime()
  } catch {
    redirect(event, fail)
    return
  }
  const cookie = await transactionCookie(event, runtime)
  const data = cookie.data
  const state = typeof data.state === 'string' ? data.state : ''
  const nonce = typeof data.nonce === 'string' ? data.nonce : ''
  const codeVerifier = typeof data.verifier === 'string' ? data.verifier : ''
  const expiresAt = typeof data.expiresAt === 'number' ? data.expiresAt : 0
  const username = typeof data.username === 'string' ? data.username : undefined
  const inviteDigest =
    typeof data.inviteDigest === 'string' ? data.inviteDigest : undefined
  await cookie.clear()
  if (!state || !nonce || !codeVerifier || expiresAt < Date.now()) {
    redirect(event, fail)
    return
  }
  try {
    await limit(
      runtime,
      's',
      'oidc:' +
        (getRequestIP(event, { xForwardedFor: false }) ?? 'unknown-source'),
    )
    const config = await oidcConfiguration(settings)
    const incoming = new URL(event.req.url, settings.redirectUri)
    const identity = await finishOidcAuthorization(
      config,
      oidcCallbackUrl(settings.redirectUri, incoming),
      { state, nonce, codeVerifier },
    )
    const decision = await decideOidcAccount(
      identity,
      { username, inviteDigest },
      directory(runtime),
    )
    if (!decision.ok) {
      redirect(event, fail)
      return
    }
    const snapshot = await runtime.credentials.findByAccount?.(
      decision.accountId,
    )
    if (!snapshot) throw unavailable()
    await establishSession(event, runtime, snapshot)
  } catch (error) {
    if (error instanceof PasswordCapacityError)
      throw createError({
        status: 429,
        message: 'Muitas tentativas. Tente novamente.',
      })
    redirect(event, fail)
    return
  }
  redirect(event, settings.origin + '/')
}

async function readUsername(request: Request): Promise<string | undefined> {
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim() !==
      'application/json' ||
    request.headers.has('content-encoding')
  )
    throw createError({ status: 415, message: 'Envie os dados em JSON.' })
  let data: unknown
  try {
    const text = await request.text()
    if (text.length > 256) throw new Error('large')
    data = JSON.parse(text)
  } catch {
    throw refused()
  }
  if (
    typeof data !== 'object' ||
    data === null ||
    Object.keys(data).length !== 1 ||
    !('username' in data) ||
    typeof data.username !== 'string' ||
    !usernamePattern.test(data.username)
  )
    return undefined
  return data.username
}
