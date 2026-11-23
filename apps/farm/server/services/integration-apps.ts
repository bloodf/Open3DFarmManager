import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import {
  INTEGRATION_SCOPES,
  type IntegrationScope,
} from '../../app/utils/integration-scopes.ts'
export {
  INTEGRATION_SCOPES,
  type IntegrationScope,
} from '../../app/utils/integration-scopes.ts'

export function validScopes(value: unknown): value is IntegrationScope[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    new Set(value).size === value.length &&
    value.every((scope) => INTEGRATION_SCOPES.includes(scope as never))
  )
}

export interface IntegrationApp {
  id: string
  farmId: string
  name: string
  sandbox: boolean
  createdAt: number
  revokedAt: number | null
}
/** Never carries the secret or its digest. */
export interface IntegrationCredential {
  id: string
  appId: string
  clientId: string
  createdAt: number
  revokedAt: number | null
}
export interface IntegrationGrant {
  id: string
  appId: string
  farmId: string
  /** Null for a farm-wide grant; otherwise the printer assignment the grant is limited to. */
  printerAssignmentId: string | null
  scopes: IntegrationScope[]
  requiresApproval: boolean
  createdAt: number
  disabledAt: number | null
  disabledReason: 'revoked' | 'assignment-revoked' | null
}
export interface NewGrant {
  appId: string
  farmId: string
  printerAssignmentId?: string
  scopes: IntegrationScope[]
  requiresApproval?: boolean
}
/** What the store keeps for one credential: the digest only. */
export interface StoredCredential extends IntegrationCredential {
  secretHash: string
}

export type StoreFailure =
  | 'not-found'
  | 'invalid-input'
  | 'sandbox-violation'
  | 'printer-unavailable'
  | 'conflict'

/**
 * Each method authorizes the actor as an active owner or admin of the farm
 * in its own transaction. Others and unknown farms look the same: not-found.
 */
export interface IntegrationAppsStore {
  createApp(
    actorId: string,
    input: { farmId: string; name: string; sandbox: boolean },
    now: number,
  ): Promise<IntegrationApp | StoreFailure>
  revokeApp(
    actorId: string,
    appId: string,
    now: number,
  ): Promise<'ok' | StoreFailure>
  addCredential(
    actorId: string,
    appId: string,
    input: { clientId: string; secretHash: string },
    now: number,
  ): Promise<IntegrationCredential | StoreFailure>
  revokeCredential(
    actorId: string,
    credentialId: string,
    now: number,
    farmId?: string,
  ): Promise<'ok' | StoreFailure>
  createGrant(
    actorId: string,
    input: NewGrant,
    now: number,
  ): Promise<IntegrationGrant | StoreFailure>
  revokeGrant(
    actorId: string,
    grantId: string,
    now: number,
    expectedFarmId?: string,
  ): Promise<
    | {
        farmId: string
        appId: string
        printerAssignmentId: string | null
      }
    | StoreFailure
  >
  listApps(actorId: string, farmId: string): Promise<IntegrationApp[] | null>
  listGrants(actorId: string, appId: string): Promise<IntegrationGrant[] | null>
  /** Token-endpoint lookup: an active credential on an active app, or null. */
  findActiveCredential(clientId: string): Promise<StoredCredential | null>
  /** Grants that currently authorize: not disabled, app active, assignment (if any) active. */
  effectiveGrants(appId: string): Promise<IntegrationGrant[]>
}

const SECRET_HASH = /^sha256:[0-9a-f]{64}$/

/** Secrets are 256 random bits, so a fast digest is enough; nothing guessable is hashed. */
export function hashClientSecret(secret: string): string {
  return 'sha256:' + createHash('sha256').update(secret, 'utf8').digest('hex')
}
export function newClientCredential(): {
  clientId: string
  secret: string
  secretHash: string
} {
  const secret = 'ofs_' + randomBytes(32).toString('base64url')
  return {
    clientId: 'ofc_' + randomBytes(18).toString('base64url'),
    secret,
    secretHash: hashClientSecret(secret),
  }
}
/** Constant-time comparison of a presented secret with a stored digest. */
export function secretMatches(stored: string, presented: string): boolean {
  const expected = Buffer.from(
    SECRET_HASH.test(stored) ? stored : 'sha256:' + '0'.repeat(64),
  )
  const actual = Buffer.from(hashClientSecret(presented))
  return timingSafeEqual(expected, actual) && SECRET_HASH.test(stored)
}

export class IntegrationAppsService {
  private readonly store: IntegrationAppsStore
  private readonly now: () => number
  constructor(store: IntegrationAppsStore, now: () => number = Date.now) {
    this.store = store
    this.now = now
  }
  createApp(
    actorId: string,
    input: { farmId: string; name: string; sandbox: boolean },
  ) {
    return this.store.createApp(actorId, input, this.now())
  }
  listApps(actorId: string, farmId: string) {
    return this.store.listApps(actorId, farmId)
  }
  listGrants(actorId: string, appId: string) {
    return this.store.listGrants(actorId, appId)
  }
  revokeApp(actorId: string, appId: string) {
    return this.store.revokeApp(actorId, appId, this.now())
  }
  revokeCredential(actorId: string, credentialId: string, farmId?: string) {
    return this.store.revokeCredential(
      actorId,
      credentialId,
      this.now(),
      farmId,
    )
  }
  revokeGrant(actorId: string, grantId: string, farmId?: string) {
    return this.store.revokeGrant(actorId, grantId, this.now(), farmId)
  }
  /** The plaintext secret is returned once and never stored. */
  async issueCredential(
    actorId: string,
    appId: string,
  ): Promise<
    { credential: IntegrationCredential; secret: string } | StoreFailure
  > {
    const fresh = newClientCredential()
    const credential = await this.store.addCredential(
      actorId,
      appId,
      { clientId: fresh.clientId, secretHash: fresh.secretHash },
      this.now(),
    )
    return typeof credential === 'string'
      ? credential
      : { credential, secret: fresh.secret }
  }
  createGrant(actorId: string, input: NewGrant) {
    if (!validScopes(input.scopes))
      return Promise.resolve('invalid-input' as const)
    return this.store.createGrant(actorId, input, this.now())
  }
  /** Active app, active credential and a matching secret, else null. Unknown clients cost the same compare. */
  async authenticate(
    clientId: string,
    secret: string,
  ): Promise<{ appId: string; grants: IntegrationGrant[] } | null> {
    const found = await this.store.findActiveCredential(clientId)
    const matched = secretMatches(found?.secretHash ?? '', secret)
    if (!found || !matched) return null
    return {
      appId: found.appId,
      grants: await this.store.effectiveGrants(found.appId),
    }
  }
}
