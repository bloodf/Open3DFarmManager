import { createError } from 'nuxt/server'
import type { IntegrationAppsService } from './integration-apps.ts'
import type { IntegrationAuditService } from './integration-audit.ts'
import { mutation } from './authenticated-session.ts'
import type { AuthRuntime } from '../utils/auth/runtime.ts'

export interface OwnerAppsDeps {
  apps: IntegrationAppsService
  audit?: IntegrationAuditService
  isOwner(actorId: string, farmId: string): Promise<boolean>
  listPrinters(
    actorId: string,
    farmId: string,
  ): Promise<{ assignmentId: string; printerKey: string }[]>
}

const farmIdPattern = /^[0-9a-f-]{36}$/i
const idPattern = /^[0-9a-f-]{36}$/i
const JSON_BODY_LIMIT = 8192

/** Origin check shared by every non-GET owner integration route. */
export function requireOwnerAppsMutation(
  event: Parameters<typeof mutation>[0],
  runtime: AuthRuntime,
): void {
  mutation(event, runtime)
}

/** JSON-only body reader for owner integration POSTs. */
export async function readOwnerAppsJsonBody(
  request: Request,
): Promise<unknown> {
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim() !==
      'application/json' ||
    request.headers.has('content-encoding')
  )
    throw createError({ status: 415, message: 'Envie os dados em JSON.' })
  const text = await request.text()
  if (text.length > JSON_BODY_LIMIT)
    throw createError({ status: 413, message: 'Solicitação muito grande.' })
  if (!text) return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw createError({ status: 400, message: 'Dados inválidos.' })
  }
}

async function requireOwner(
  deps: OwnerAppsDeps,
  actorId: string,
  farmId: string,
) {
  if (!farmIdPattern.test(farmId) || !(await deps.isOwner(actorId, farmId))) {
    throw createError({ status: 404, message: 'Farm não encontrada.' })
  }
}

export async function listOwnerApps(
  deps: OwnerAppsDeps,
  actorId: string,
  farmId: string,
) {
  await requireOwner(deps, actorId, farmId)
  const [apps, printers] = await Promise.all([
    deps.apps.listApps(actorId, farmId),
    deps.listPrinters(actorId, farmId),
  ])
  if (!apps) throw createError({ status: 404, message: 'Farm não encontrada.' })
  return { apps, printers }
}

export async function createOwnerApp(
  deps: OwnerAppsDeps,
  actorId: string,
  farmId: string,
  body: unknown,
) {
  await requireOwner(deps, actorId, farmId)
  if (
    !body ||
    typeof body !== 'object' ||
    !('name' in body) ||
    typeof body.name !== 'string' ||
    body.name.trim().length < 1 ||
    body.name.trim().length > 128
  ) {
    throw createError({
      status: 400,
      message: 'Informe um nome de até 128 caracteres.',
    })
  }
  const sandbox = 'sandbox' in body && body.sandbox === true
  const app = await deps.apps.createApp(actorId, {
    farmId,
    name: body.name,
    sandbox,
  })
  if (typeof app === 'string')
    throw createError({
      status: app === 'not-found' ? 404 : 400,
      message: 'Não foi possível cadastrar o aplicativo.',
    })
  const issued = await deps.apps.issueCredential(actorId, app.id)
  if (typeof issued === 'string') {
    await deps.apps.revokeApp(actorId, app.id)
    throw createError({
      status: 500,
      message: 'Não foi possível emitir a credencial.',
    })
  }
  return { app, credential: issued.credential, secret: issued.secret }
}

export async function listOwnerGrants(
  deps: OwnerAppsDeps,
  actorId: string,
  farmId: string,
  appId: string,
) {
  await requireOwner(deps, actorId, farmId)
  if (!idPattern.test(appId))
    throw createError({ status: 404, message: 'Aplicativo não encontrado.' })
  const grants = await deps.apps.listGrants(actorId, appId)
  if (!grants || grants.some((grant) => grant.farmId !== farmId))
    throw createError({ status: 404, message: 'Aplicativo não encontrado.' })
  return { grants }
}

export async function createOwnerGrant(
  deps: OwnerAppsDeps,
  actorId: string,
  farmId: string,
  appId: string,
  body: unknown,
) {
  await requireOwner(deps, actorId, farmId)
  if (!idPattern.test(appId) || !body || typeof body !== 'object')
    throw createError({ status: 400, message: 'Dados de acesso inválidos.' })
  const input = body as Record<string, unknown>
  if (
    !Array.isArray(input.scopes) ||
    input.scopes.some((scope) => typeof scope !== 'string')
  )
    throw createError({ status: 400, message: 'Selecione ao menos um escopo.' })
  const result = await deps.apps.createGrant(actorId, {
    appId,
    farmId,
    ...(typeof input.printerAssignmentId === 'string'
      ? { printerAssignmentId: input.printerAssignmentId }
      : {}),
    scopes: input.scopes as never[],
    requiresApproval: input.requiresApproval === true,
  })
  if (typeof result === 'string')
    throw createError({
      status: result === 'not-found' ? 404 : 400,
      message: 'Não foi possível conceder esses escopos.',
    })
  return { grant: result }
}

export async function revokeOwnerGrant(
  deps: OwnerAppsDeps,
  actorId: string,
  farmId: string,
  grantId: string,
) {
  await requireOwner(deps, actorId, farmId)
  if (!idPattern.test(grantId))
    throw createError({ status: 404, message: 'Acesso não encontrado.' })
  const result = await deps.apps.revokeGrant(actorId, grantId, farmId)
  if (typeof result === 'string')
    throw createError({ status: 404, message: 'Acesso não encontrado.' })
  await deps.audit?.record({
    farmId: result.farmId,
    appId: result.appId,
    printerAssignmentId: result.printerAssignmentId,
    actorKind: 'owner',
    actorId,
    action: 'credential.event',
    resourceType: 'credential',
    resourceId: grantId,
    outcome: 'revoked',
    details: { credentialEvent: 'grant-revoked' },
  })
  return { ok: true }
}

export async function revokeOwnerApp(
  deps: OwnerAppsDeps,
  actorId: string,
  farmId: string,
  appId: string,
) {
  await requireOwner(deps, actorId, farmId)
  if (!idPattern.test(appId))
    throw createError({ status: 404, message: 'Aplicativo não encontrado.' })
  const apps = await deps.apps.listApps(actorId, farmId)
  if (!apps?.some((app) => app.id === appId))
    throw createError({ status: 404, message: 'Aplicativo não encontrado.' })
  const result = await deps.apps.revokeApp(actorId, appId)
  if (result !== 'ok')
    throw createError({ status: 404, message: 'Aplicativo não encontrado.' })
  await deps.audit?.record({
    farmId,
    appId,
    printerAssignmentId: null,
    actorKind: 'owner',
    actorId,
    action: 'credential.event',
    resourceType: 'credential',
    resourceId: appId,
    outcome: 'revoked',
    details: { credentialEvent: 'app-revoked' },
  })
  return { ok: true }
}

export async function revokeOwnerCredential(
  deps: OwnerAppsDeps,
  actorId: string,
  farmId: string,
  credentialId: string,
) {
  await requireOwner(deps, actorId, farmId)
  if (!idPattern.test(credentialId))
    throw createError({ status: 404, message: 'Credencial não encontrada.' })
  const result = await deps.apps.revokeCredential(actorId, credentialId, farmId)
  if (result !== 'ok')
    throw createError({ status: 404, message: 'Credencial não encontrada.' })
  await deps.audit?.record({
    farmId,
    appId: null,
    printerAssignmentId: null,
    actorKind: 'owner',
    actorId,
    action: 'credential.event',
    resourceType: 'credential',
    resourceId: credentialId,
    outcome: 'revoked',
    details: { credentialEvent: 'credential-revoked' },
  })
  return { ok: true }
}
