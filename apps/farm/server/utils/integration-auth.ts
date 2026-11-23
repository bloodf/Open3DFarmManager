import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import {
  INTEGRATION_SCOPES,
  secretMatches,
  type IntegrationAppsStore,
  type IntegrationGrant,
  type IntegrationScope,
} from '../services/integration-apps.ts'

export type IntegrationAuthStore = Pick<
  IntegrationAppsStore,
  'findActiveCredential' | 'effectiveGrants'
> & {
  activePrinterFarm(printerId: string): Promise<string | null>
  readPrinters?(input: {
    farmIds: string[]
    farmWideFarmIds: string[]
    assignmentIds: string[]
    farmId?: string
    afterId?: string
    snapshotAt: number
    limit: number
  }): Promise<IntegrationPrinterRow[]>
  readPrinter?(printerId: string): Promise<IntegrationPrinterRow | null>
}

export interface IntegrationPrinterRow {
  agentId?: string
  id: string
  farmId: string
  printerKey: string
  displayName?: string | null
  groupName?: string | null
  location?: string | null
  sandbox: boolean
  assignedAt?: number
  state: unknown
  observedAt: number | null
}

export interface IntegrationPrincipal {
  appId: string
  scopes: readonly IntegrationScope[]
  grants: readonly IntegrationGrant[]
}

const context = 'openfarm-integrations-v1.'
export const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseIntegrationTokenConfig(raw: {
  signingKey: unknown
  tokenTtlSeconds: unknown
}) {
  const encoded = raw.signingKey
  const ttl =
    typeof raw.tokenTtlSeconds === 'string' && /^\d+$/.test(raw.tokenTtlSeconds)
      ? Number(raw.tokenTtlSeconds)
      : raw.tokenTtlSeconds
  if (
    typeof encoded !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(encoded) ||
    typeof ttl !== 'number' ||
    !Number.isInteger(ttl) ||
    ttl < 1 ||
    ttl > 3600
  )
    throw new Error('Configuração de autenticação de integrações inválida.')
  const key = Buffer.from(encoded, 'base64url')
  if (key.toString('base64url') !== encoded)
    throw new Error('Configuração de autenticação de integrações inválida.')
  return { key, ttl }
}

function grantFingerprint(grants: IntegrationGrant[], mask: number) {
  const covered = grants.filter((grant) =>
    grant.scopes.some(
      (scope) => mask & (1 << INTEGRATION_SCOPES.indexOf(scope)),
    ),
  )
  const scopedGrants = covered.map((grant) => ({
    ...grant,
    scopes: INTEGRATION_SCOPES.filter(
      (scope, index) => mask & (1 << index) && grant.scopes.includes(scope),
    ),
  }))
  const snapshot = scopedGrants.map((grant) =>
    JSON.stringify([
      grant.id,
      grant.farmId,
      grant.printerAssignmentId,
      grant.scopes,
      grant.requiresApproval,
    ]),
  )
  return {
    grants: scopedGrants,
    fingerprint: createHash('sha256')
      .update(JSON.stringify(snapshot.sort()))
      .digest('base64url'),
  }
}

export class IntegrationAuth {
  readonly store: IntegrationAuthStore
  private readonly config: ReturnType<typeof parseIntegrationTokenConfig>
  private readonly now: () => number

  constructor(
    store: IntegrationAuthStore,
    config: ReturnType<typeof parseIntegrationTokenConfig>,
    now: () => number = Date.now,
  ) {
    this.store = store
    this.config = config
    this.now = now
  }

  private sign(payload: string) {
    return createHmac('sha256', this.config.key)
      .update(context + payload)
      .digest()
  }

  private signCameraTicket(payload: string) {
    return createHmac('sha256', this.config.key)
      .update('openfarm-camera-link-v1.' + payload)
      .digest()
  }

  issueCameraLink(appId: string, printerId: string, grantId: string) {
    const expiresAt = this.now() + 120_000
    const payload = Buffer.from(
      JSON.stringify([appId, printerId, grantId, expiresAt]),
    ).toString('base64url')
    const signature = this.signCameraTicket(payload).toString('base64url')
    return { url: '/camera-view#' + payload + '.' + signature, expiresAt }
  }

  async redeemCameraTicket(ticket: string) {
    const match = /^([A-Za-z0-9_-]{1,260})\.([A-Za-z0-9_-]{43})$/.exec(ticket)
    if (!match) return null
    const payload = match[1]!
    const signature = Buffer.from(match[2]!, 'base64url')
    if (
      signature.toString('base64url') !== match[2] ||
      !timingSafeEqual(signature, this.signCameraTicket(payload))
    )
      return null
    const [appId, printerId, grantId, expiresAt] = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as [string, string, string, number]
    if (expiresAt <= this.now()) return null
    const printer = await this.store.readPrinter?.(printerId)
    if (!printer) return null
    const grants = await this.store.effectiveGrants(appId)
    const allowed = grants.some(
      (grant) =>
        grant.id === grantId &&
        grant.scopes.includes('camera:view') &&
        grant.farmId === printer.farmId &&
        (grant.printerAssignmentId === null ||
          grant.printerAssignmentId === printer.id),
    )
    return allowed && expiresAt > this.now() ? printer : null
  }

  async issue(
    clientId: string,
    secret: string,
    requested: string[] | undefined,
  ) {
    const credential = await this.store.findActiveCredential(clientId)
    const match = secretMatches(credential?.secretHash ?? '', secret)
    if (!credential || !match) return 'invalid_client'
    const grants = await this.store.effectiveGrants(credential.appId)
    const available = new Set(grants.flatMap((grant) => grant.scopes))
    if (requested?.some((scope) => !available.has(scope as IntegrationScope)))
      return 'invalid_scope'
    const scopes = INTEGRATION_SCOPES.filter((scope) =>
      requested ? requested.includes(scope) : available.has(scope),
    )
    const mask = INTEGRATION_SCOPES.reduce(
      (value, scope, index) =>
        scopes.includes(scope) ? value | (1 << index) : value,
      0,
    )
    const payload = Buffer.from(
      JSON.stringify({
        clientId,
        credentialId: credential.id,
        appId: credential.appId,
        exp: this.now() + this.config.ttl * 1000,
        mask,
        grants: grantFingerprint(grants, mask).fingerprint,
      }),
    ).toString('base64url')
    return {
      access_token: payload + '.' + this.sign(payload).toString('base64url'),
      token_type: 'Bearer',
      expires_in: this.config.ttl,
      scope: scopes.join(' '),
    }
  }

  async verify(token: string): Promise<IntegrationPrincipal | null> {
    if (!/^[A-Za-z0-9_-]{1,1024}\.[A-Za-z0-9_-]{43}$/.test(token)) return null
    const [payload, signature] = token.split('.') as [string, string]
    const bytes = Buffer.from(signature, 'base64url')
    if (
      bytes.toString('base64url') !== signature ||
      !timingSafeEqual(this.sign(payload), bytes)
    )
      return null
    // The signature authenticates the versioned payload before decoding it.
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      clientId: string
      credentialId: string
      appId: string
      exp: number
      mask: number
      grants: string
    }
    if (claims.exp <= this.now()) return null
    const credential = await this.store.findActiveCredential(claims.clientId)
    if (
      !credential ||
      credential.id !== claims.credentialId ||
      credential.appId !== claims.appId
    )
      return null
    const current = grantFingerprint(
      await this.store.effectiveGrants(claims.appId),
      claims.mask,
    )
    if (current.fingerprint !== claims.grants || claims.exp <= this.now())
      return null
    return {
      appId: claims.appId,
      scopes: INTEGRATION_SCOPES.filter(
        (_, index) => claims.mask & (1 << index),
      ),
      grants: current.grants,
    }
  }
}
