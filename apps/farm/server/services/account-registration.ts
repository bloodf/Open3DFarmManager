import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createError, type RequestEvent } from 'nuxt/server'
import {
  authenticatedSession,
  establishSession,
  limit,
  mutation,
  readLoginBody,
} from './authenticated-session.ts'
import { resetTokenDigest } from './password-reset.ts'
import { hashPassword, PasswordCapacityError } from '../utils/auth/password.ts'
import type { AuthRuntime } from '../utils/auth/runtime.ts'
import { getRequestIP } from 'nuxt/server'
import type { InviteRole } from '../storage/postgres-registration.ts'

type AuthEvent = Pick<RequestEvent, 'req' | 'res'>

export const INVITE_TTL_MS = 72 * 60 * 60 * 1000
export const MIN_PASSWORD_CHARS = 12
const farmUuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const inviteRoles: readonly string[] = ['admin', 'operator', 'viewer']

const unavailable = () =>
  createError({
    status: 503,
    message: 'Criação de conta indisponível. Tente novamente.',
  })
/** One message for bad token, spent/expired invite, taken username and closed bootstrap. */
const refused = () =>
  createError({
    status: 400,
    message:
      'Não foi possível criar a conta. Confira o código, escolha outro usuário e use uma senha com 12 caracteres ou mais.',
  })

function registrationStore(runtime: AuthRuntime) {
  if (!runtime.registration)
    throw createError({ status: 404, message: 'Recurso indisponível.' })
  return runtime.registration
}
async function createAccount(
  event: AuthEvent,
  runtime: AuthRuntime,
  create: (username: string, passwordHash: string) => Promise<boolean>,
): Promise<{ accountId: string }> {
  registrationStore(runtime)
  mutation(event, runtime)
  await limit(
    runtime,
    's',
    'register:' +
      (getRequestIP(event, { xForwardedFor: false }) ?? 'unknown-source'),
  )
  const input = await readLoginBody(event.req)
  await limit(runtime, 'a', 'register:' + input.username)
  if ([...input.password].length < MIN_PASSWORD_CHARS) throw refused()
  let created: boolean
  try {
    created = await create(input.username, await hashPassword(input.password))
  } catch (error) {
    if (error instanceof PasswordCapacityError)
      throw createError({
        status: 429,
        message: 'Muitas tentativas. Tente novamente.',
      })
    throw unavailable()
  }
  if (!created) throw refused()
  let snapshot
  try {
    snapshot = await runtime.credentials.find(input.username)
  } catch {
    throw unavailable()
  }
  if (!snapshot) throw unavailable()
  return await establishSession(event, runtime, snapshot)
}

/** First owner: only with the deployment bootstrap secret and only while no account exists. */
export async function bootstrapOwner(event: AuthEvent, runtime: AuthRuntime) {
  const expected = runtime.bootstrapTokenDigest
  const header = event.req.headers.get('x-bootstrap-token') ?? ''
  const given = createHash('sha256').update(header).digest()
  // Bootstrap disabled (no secret configured) is indistinguishable from a wrong secret.
  const ok = expected !== undefined && timingSafeEqual(expected, given)
  return await createAccount(event, runtime, async (username, hash) => {
    if (!ok) return false
    return registrationStore(runtime).bootstrap(username, hash)
  })
}

export async function registerWithInvite(
  event: AuthEvent,
  runtime: AuthRuntime,
) {
  const token = event.req.headers.get('x-invite-token') ?? ''
  return await createAccount(event, runtime, async (username, hash) => {
    let digest: string
    try {
      digest = resetTokenDigest(token)
    } catch {
      return false
    }
    return registrationStore(runtime).register(digest, username, hash)
  })
}

/** Authenticated farm owner mints a single-use invite; the token is returned exactly once. */
export async function createFarmInvite(
  event: AuthEvent,
  runtime: AuthRuntime,
  farmId: string,
): Promise<{ token: string; expiresAt: string; role: InviteRole }> {
  registrationStore(runtime)
  mutation(event, runtime)
  const { accountId } = await authenticatedSession(event, runtime)
  await limit(runtime, 'a', 'invite:' + accountId)
  const body = await readInviteBody(event.req)
  if (!farmUuid.test(farmId))
    throw createError({ status: 400, message: 'Solicitação inválida.' })
  const token = randomBytes(32).toString('base64url')
  let expiresAt: Date | null
  try {
    expiresAt = await registrationStore(runtime).createInvite(
      accountId,
      farmId,
      body.role,
      resetTokenDigest(token),
      INVITE_TTL_MS,
    )
  } catch {
    throw unavailable()
  }
  if (!expiresAt)
    throw createError({
      status: 403,
      message: 'Somente proprietários da farm podem criar convites.',
    })
  return { token, expiresAt: expiresAt.toISOString(), role: body.role }
}

async function readInviteBody(request: Request): Promise<{ role: InviteRole }> {
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim() !==
      'application/json' ||
    request.headers.has('content-encoding')
  )
    throw createError({ status: 415, message: 'Envie os dados em JSON.' })
  const length = request.headers.get('content-length')
  if (length !== null && (!/^\d{1,4}$/.test(length) || Number(length) > 256))
    throw createError({ status: 413, message: 'Solicitação muito grande.' })
  let data: unknown
  try {
    const text = await request.text()
    if (text.length > 256) throw new Error()
    data = JSON.parse(text)
  } catch {
    throw createError({ status: 400, message: 'Solicitação inválida.' })
  }
  if (
    typeof data !== 'object' ||
    data === null ||
    Object.keys(data).length !== 1 ||
    !('role' in data) ||
    typeof data.role !== 'string' ||
    !inviteRoles.includes(data.role)
  )
    throw createError({ status: 400, message: 'Solicitação inválida.' })
  return { role: data.role as InviteRole }
}
