import {
  createError,
  getRequestIP,
  useSession,
  type RequestEvent,
} from 'nuxt/server'
import {
  authResponse,
  authenticatedSession,
  establishSession,
  limit,
} from '../services/authenticated-session.ts'
import { SESSION_COOKIE_ATTRIBUTES } from './auth/boundary.ts'
import { authRuntime, type AuthRuntime } from './auth/runtime.ts'
import { PasswordCapacityError } from './auth/password.ts'
import { oidcConfiguration } from './oidc-client.ts'
import type { OidcSettings } from './oidc-config.ts'
import {
  beginGoogleAuthorization,
  completeGoogleSignIn,
  finishGoogleAuthorization,
} from './oidc-google.ts'
import { decideGoogleAccountLink } from './identity-google.ts'
import {
  GOOGLE_PROVIDER_PRESET,
  googleRedirectUri,
} from './google-provider-preset.ts'
import { oidcCallbackUrl } from './oidc-login.ts'

const GOOGLE_COOKIE = '__Host-open3dfarmmanager-google'
const TRANSACTION_MS = 10 * 60 * 1000

type AuthEvent = Pick<RequestEvent, 'req' | 'res'>

const unavailable = () =>
  createError({ status: 503, message: 'Autenticação indisponível.' })
const refused = () =>
  createError({
    status: 400,
    message: 'Não foi possível iniciar o acesso pelo Google.',
  })

async function googleSettings(
  runtime: AuthRuntime,
): Promise<OidcSettings | null> {
  const credentials = await runtime.signInProviders?.runtimeCredentials()
  if (!credentials) return null
  return {
    issuer: credentials.issuer,
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    redirectUri: googleRedirectUri(runtime.origin),
    origin: runtime.origin,
  }
}

function redirect(event: AuthEvent, location: string): void {
  authResponse(event)
  event.res.headers.set('Referrer-Policy', 'no-referrer')
  event.res.status = 303
  event.res.headers.set('location', location)
}

async function transactionCookie(event: AuthEvent, runtime: AuthRuntime) {
  return await useSession(event, {
    name: GOOGLE_COOKIE,
    password: runtime.cookie.password,
    maxAge: TRANSACTION_MS / 1000,
    cookie: { ...SESSION_COOKIE_ATTRIBUTES },
  })
}

export async function googleStatus(event: AuthEvent) {
  authResponse(event)
  const runtime = authRuntime()
  if (!runtime.signInProviders)
    return { enabled: false as const, reason: 'disabled' as const }
  return await runtime.signInProviders.publicStatus()
}

export async function googleStartGet(event: AuthEvent): Promise<void> {
  await googleStart(event, {})
}

/** Link Google to the signed-in account. */
export async function googleLinkStartGet(event: AuthEvent): Promise<void> {
  const runtime = authRuntime()
  const auth = await authenticatedSession(event, runtime)
  await googleStart(event, { linkAccountId: auth.accountId })
}

async function googleStart(
  event: AuthEvent,
  extra: { linkAccountId?: string },
): Promise<void> {
  const runtime = authRuntime()
  const settings = await googleSettings(runtime)
  if (!settings)
    throw createError({ status: 404, message: 'Recurso indisponível.' })
  if (new URL(event.req.url, settings.redirectUri).search) throw refused()
  await limit(
    runtime,
    's',
    'google:' +
      (getRequestIP(event, { xForwardedFor: false }) ?? 'unknown-source'),
  )
  const config = await oidcConfiguration(settings).catch(() => {
    throw unavailable()
  })
  const begun = await beginGoogleAuthorization(config, settings.redirectUri)
  const cookie = await transactionCookie(event, runtime)
  await cookie.update({
    state: begun.state,
    nonce: begun.nonce,
    verifier: begun.codeVerifier,
    expiresAt: Date.now() + TRANSACTION_MS,
    ...(extra.linkAccountId ? { linkAccountId: extra.linkAccountId } : {}),
  })
  redirect(event, begun.url.href)
}

export async function googleCallback(event: AuthEvent): Promise<void> {
  let runtime: AuthRuntime
  try {
    runtime = authRuntime()
  } catch {
    throw createError({ status: 503, message: 'Autenticação indisponível.' })
  }
  const settings = await googleSettings(runtime)
  const fail = runtime.origin + '/entrar#erro=google'
  if (!settings) {
    redirect(event, fail)
    return
  }
  const cookie = await transactionCookie(event, runtime)
  const data = cookie.data
  const state = typeof data.state === 'string' ? data.state : ''
  const nonce = typeof data.nonce === 'string' ? data.nonce : ''
  const codeVerifier = typeof data.verifier === 'string' ? data.verifier : ''
  const expiresAt = typeof data.expiresAt === 'number' ? data.expiresAt : 0
  const linkAccountId =
    typeof data.linkAccountId === 'string' ? data.linkAccountId : undefined
  await cookie.clear()
  if (!state || !nonce || !codeVerifier || expiresAt < Date.now()) {
    redirect(event, fail)
    return
  }
  const linkFail = runtime.origin + '/conta#erro=google-vinculo'
  try {
    await limit(
      runtime,
      's',
      'google:' +
        (getRequestIP(event, { xForwardedFor: false }) ?? 'unknown-source'),
    )
    const config = await oidcConfiguration(settings)
    const incoming = new URL(event.req.url, settings.redirectUri)
    const callback = oidcCallbackUrl(settings.redirectUri, incoming)
    if (linkAccountId) {
      if (!runtime.oidc || !runtime.identities) throw unavailable()
      const identity = await finishGoogleAuthorization(config, callback, {
        state,
        nonce,
        codeVerifier,
      })
      const decision = await decideGoogleAccountLink(identity, linkAccountId, {
        findLink: (issuer, subject) => runtime.oidc!.findLink(issuer, subject),
        link: (accountId, issuer, subject) =>
          runtime.identities!.link(accountId, issuer, subject),
      })
      if (!decision.ok) {
        redirect(event, linkFail)
        return
      }
      redirect(event, runtime.origin + '/conta#google=vinculado')
      return
    }
    const decision = await completeGoogleSignIn(
      config,
      callback,
      { state, nonce, codeVerifier },
      {},
      runtime,
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
  redirect(event, runtime.origin + '/')
}

/** Exported for tests that assert the preset redirect path. */
export const googleCallbackPath = GOOGLE_PROVIDER_PRESET.redirectPath
