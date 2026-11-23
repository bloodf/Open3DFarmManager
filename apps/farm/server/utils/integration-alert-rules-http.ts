import { defineEventHandler, useRuntimeConfig } from 'nuxt/server'
import {
  FARM_ALERT_META,
  FARM_ALERT_ORDER,
  type FarmAlertKind,
} from '../../app/utils/farm-alerts.ts'
import { alertRulesStore } from '../storage/alert-rules-postgres.ts'
import {
  deliverNotificationTest,
  parseNotificationChannel,
} from './alert-rules/delivery.ts'
import { integrationProblem, readText } from './integration-auth-http.ts'
import { uuidPattern, type IntegrationPrincipal } from './integration-auth.ts'
import { credentialKeyring } from './sealed-credential-key.ts'
import { openWebhookSecret, sealWebhookSecret } from './webhooks/secret.ts'

type Operation = 'list' | 'update-rule' | 'configure-channel' | 'test-channel'

function rule(kind: FarmAlertKind, enabled: boolean) {
  return { kind, label: FARM_ALERT_META[kind].label, enabled }
}

async function jsonBody(request: Request): Promise<unknown> {
  if (
    request.headers.has('content-encoding') ||
    request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
      'application/json'
  )
    return null
  try {
    return JSON.parse(await readText(request, 8192))
  } catch {
    return null
  }
}

export function alertSettingsHandler(operation: Operation) {
  return defineEventHandler(async (event) => {
    const headers = event.res.headers
    headers.set('cache-control', 'no-store')
    const farmId = (event.context.params?.farmId ?? '').toLowerCase()
    const principal = event.context.integrationAuth as IntegrationPrincipal
    const scope = operation === 'list' ? 'printers:read' : 'alerts:manage'
    const grants = principal.grants.filter(
      (grant) =>
        grant.farmId === farmId &&
        grant.printerAssignmentId === null &&
        grant.scopes.includes(scope),
    )
    if (!uuidPattern.test(farmId) || !grants.length)
      return integrationProblem('not-found', headers)

    const request = event.req
    if (new URL(request.url).searchParams.size)
      return integrationProblem('invalid-request', headers)

    try {
      const store = alertRulesStore()
      if (operation === 'list') {
        const overrides = new Map(
          (await store.list(farmId)).map(({ kind, enabled }) => [
            kind,
            enabled,
          ]),
        )
        return {
          farmId,
          rules: FARM_ALERT_ORDER.map((kind) =>
            rule(kind, overrides.get(kind) ?? true),
          ),
        }
      }

      const grantIds = grants
        .filter((grant) => !grant.requiresApproval)
        .map((grant) => grant.id)
      const denied = () => integrationProblem('insufficient-scope', headers)
      if (!grantIds.length) return denied()

      if (operation === 'update-rule') {
        const kind = FARM_ALERT_ORDER.find(
          (kind) => kind === event.context.params?.kind,
        )
        if (!kind) return integrationProblem('not-found', headers)
        const body = await jsonBody(request)
        if (
          !body ||
          typeof body !== 'object' ||
          Object.keys(body).length !== 1 ||
          !('enabled' in body) ||
          typeof body.enabled !== 'boolean'
        )
          return integrationProblem('invalid-request', headers)
        const enabled = body.enabled
        const result = await store.manage(
          principal.appId,
          farmId,
          grantIds,
          async (settings) => {
            await settings.writeRule(kind, enabled)
            return rule(kind, enabled)
          },
        )
        return result?.value ?? denied()
      }

      if (operation === 'configure-channel') {
        const configuration = parseNotificationChannel(await jsonBody(request))
        if (!configuration)
          return integrationProblem('invalid-request', headers)
        const result = await store.manage(
          principal.appId,
          farmId,
          grantIds,
          async (settings) => {
            const sealed = sealWebhookSecret(
              JSON.stringify(configuration),
              credentialKeyring(useRuntimeConfig().auth ?? {}),
            )
            await settings.writeChannel(sealed)
            return { farmId, configured: true }
          },
        )
        return result?.value ?? denied()
      }

      if (request.body !== null)
        return integrationProblem('invalid-request', headers)
      const result = await store.manage(
        principal.appId,
        farmId,
        grantIds,
        (settings) => settings.readChannel(),
      )
      if (!result) return denied()
      const sealed = result.value
      if (!sealed) return integrationProblem('not-found', headers)
      const opened = openWebhookSecret(
        sealed,
        credentialKeyring(useRuntimeConfig().auth ?? {}),
      )
      const configuration = opened.legacy
        ? null
        : parseNotificationChannel(JSON.parse(opened.secret))
      if (!configuration)
        return integrationProblem('service-unavailable', headers)
      return await deliverNotificationTest(farmId, configuration)
    } catch {
      return integrationProblem('service-unavailable', headers)
    }
  })
}
