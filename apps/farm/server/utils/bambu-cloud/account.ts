import type { Logger } from '@open3dfarmmanager/shared'
import { isBambuCloudEnabled } from '../../../../../packages/connector/src/bambu/cloud.ts'
import { loginBambuCloud, type BambuCloudMqtt } from './cloud-client.ts'
import { sealBambuCloudSecret, type SealedSecret } from './secret.ts'

export const BAMBU_FARM_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ACTOR_ID = /^[A-Za-z0-9_-]{1,128}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const CODE = /^\d{4,8}$/
const TOKEN = /^[\x21-\x7E]{16,4096}$/
const TFA_KEY = /^[\x21-\x7E]{8,200}$/
const PASSWORD = /^[\x20-\x7E]{1,200}$/
const WHEN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/

export type BambuRegion = 'global' | 'china'

export type BambuCloudAccountView = {
  connected: boolean
  region: BambuRegion | null
  account: string | null
  expiresAt: string | null
  expired: boolean
  mqtt: BambuCloudMqtt | null
}

export const DISCONNECTED_BAMBU_CLOUD_ACCOUNT: BambuCloudAccountView =
  Object.freeze({
    connected: false,
    region: null,
    account: null,
    expiresAt: null,
    expired: false,
    mqtt: null,
  })

export type BambuCloudFailure =
  | 'forbidden'
  | 'not-found'
  | 'invalid-input'
  | 'cloud-disabled'
  | 'cloud-rejected'
  | 'cloud-unauthorized'
  | 'storage-unavailable'

export type BambuCloudConnectResult =
  | { ok: true; account: BambuCloudAccountView }
  | { ok: true; tfaRequired: true; tfaKey: string }
  | { ok: false; reason: BambuCloudFailure }

export type BambuCloudConnectRequest =
  | {
      mode: 'email-code'
      account: string
      code: string
      region: BambuRegion
      endpoint?: string | undefined
    }
  | {
      mode: 'password'
      account: string
      password: string
      region: BambuRegion
      endpoint?: string | undefined
    }
  | {
      mode: 'tfa'
      account: string
      tfaKey: string
      tfaCode: string
      region: BambuRegion
      endpoint?: string | undefined
    }
  | {
      mode: 'token'
      account: string
      accessToken: string
      refreshToken?: string | undefined
      expiresAt: string
      region: BambuRegion
    }

export type BambuCloudDraft = {
  region: BambuRegion
  account: string
  accessToken: string
  refreshToken: string | null
  expiresAt: string
  cloudOrigin: string | null
  mqtt: BambuCloudMqtt | null
}

export type StoredBambuCloudAccount = {
  region: BambuRegion
  account: string
  expiresAt: string
  mqtt: BambuCloudMqtt | null
}

type MemberGate = 'owner' | 'forbidden' | 'not-found' | 'storage-unavailable'
type WriteGate = MemberGate | 'invalid-input' | 'ok'

export interface BambuCloudAccountStore {
  member(actor: { farmId: string; accountId: string }): Promise<MemberGate>
  read(
    farmId: string,
  ): Promise<StoredBambuCloudAccount | null | 'storage-unavailable'>
  write(
    farmId: string,
    accountId: string,
    draft: BambuCloudDraft,
  ): Promise<WriteGate>
  remove(farmId: string, accountId: string): Promise<MemberGate | 'ok'>
}

type SavedRow = StoredBambuCloudAccount & {
  access: SealedSecret
  refresh: SealedSecret | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, pattern: RegExp): string | null {
  if (typeof value !== 'string' || !pattern.test(value)) return null
  return value
}

function regionOf(value: unknown): BambuRegion | null {
  return value === 'global' || value === 'china' ? value : null
}

function emailOf(value: unknown): string | null {
  const account = text(value, /^[\x21-\x7E]{3,320}$/)
  if (!account || !EMAIL.test(account)) return null
  return account
}

function endpointOf(value: unknown): string | undefined | null {
  if (value === undefined) return undefined
  return text(value, /^[\x21-\x7E]{1,128}$/)
}

function expiresOf(value: unknown): string | null {
  const raw = text(value, WHEN)
  if (!raw) return null
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

function onlyKeys(body: Record<string, unknown>, keys: readonly string[]) {
  const allowed = new Set(keys)
  return Object.keys(body).every((key) => allowed.has(key))
}

/** Rejects unknown fields so a token cannot ride along on another mode. */
export function parseBambuCloudConnectRequest(
  value: unknown,
): BambuCloudConnectRequest | null {
  if (!isRecord(value)) return null
  const region = regionOf(value.region)
  const account = emailOf(value.account)
  if (!region || !account) return null
  if (value.mode === 'email-code') {
    const code = text(value.code, CODE)
    const endpoint = endpointOf(value.endpoint)
    if (
      !code ||
      endpoint === null ||
      !onlyKeys(value, ['mode', 'account', 'code', 'region', 'endpoint'])
    )
      return null
    return endpoint === undefined
      ? { mode: 'email-code', account, code, region }
      : { mode: 'email-code', account, code, region, endpoint }
  }
  if (value.mode === 'password') {
    const password = text(value.password, PASSWORD)
    const endpoint = endpointOf(value.endpoint)
    if (
      !password ||
      endpoint === null ||
      !onlyKeys(value, ['mode', 'account', 'password', 'region', 'endpoint'])
    )
      return null
    return endpoint === undefined
      ? { mode: 'password', account, password, region }
      : { mode: 'password', account, password, region, endpoint }
  }
  if (value.mode === 'tfa') {
    const tfaKey = text(value.tfaKey, TFA_KEY)
    const tfaCode = text(value.tfaCode, CODE)
    const endpoint = endpointOf(value.endpoint)
    if (
      !tfaKey ||
      !tfaCode ||
      endpoint === null ||
      !onlyKeys(value, [
        'mode',
        'account',
        'tfaKey',
        'tfaCode',
        'region',
        'endpoint',
      ])
    )
      return null
    return endpoint === undefined
      ? { mode: 'tfa', account, tfaKey, tfaCode, region }
      : { mode: 'tfa', account, tfaKey, tfaCode, region, endpoint }
  }
  if (value.mode === 'token') {
    const accessToken = text(value.accessToken, TOKEN)
    const expiresAt = expiresOf(value.expiresAt)
    if (
      !accessToken ||
      !expiresAt ||
      !onlyKeys(value, [
        'mode',
        'account',
        'accessToken',
        'refreshToken',
        'expiresAt',
        'region',
      ])
    )
      return null
    if (value.refreshToken === undefined)
      return { mode: 'token', account, accessToken, expiresAt, region }
    const refreshToken = text(value.refreshToken, TOKEN)
    if (!refreshToken) return null
    return {
      mode: 'token',
      account,
      accessToken,
      refreshToken,
      expiresAt,
      region,
    }
  }
  return null
}

export function bambuCloudAccountView(
  row: StoredBambuCloudAccount | null,
  now: Date,
): BambuCloudAccountView {
  if (!row) return DISCONNECTED_BAMBU_CLOUD_ACCOUNT
  return {
    connected: true,
    region: row.region,
    account: row.account,
    expiresAt: row.expiresAt,
    expired: new Date(row.expiresAt).getTime() <= now.getTime(),
    mqtt: row.mqtt,
  }
}

function logAccount(
  logger: Logger,
  message: string,
  fields: {
    farmId: string
    region?: BambuRegion | undefined
    expired?: boolean | undefined
    connected?: boolean | undefined
    outcome:
      | 'connected'
      | 'disconnected'
      | 'forbidden'
      | 'not-found'
      | 'rejected'
      | 'tfa'
      | 'disabled'
      | 'unauthorized'
  },
) {
  const safe: Record<string, unknown> = {
    farmId: fields.farmId,
    outcome: fields.outcome,
  }
  if (fields.region) safe.region = fields.region
  if (fields.expired !== undefined) safe.expired = fields.expired
  if (fields.connected !== undefined) safe.connected = fields.connected
  logger.info(message, safe)
}

function actorOk(actor: { farmId: string; accountId: string }) {
  return BAMBU_FARM_ID.test(actor.farmId) && ACTOR_ID.test(actor.accountId)
}

export class MemoryBambuCloudAccountStore implements BambuCloudAccountStore {
  private readonly rows = new Map<string, SavedRow>()
  private readonly members = new Map<string, string>()

  constructor(private readonly master: string) {}

  setMember(farmId: string, accountId: string, role: string | null) {
    const key = `${farmId}\0${accountId}`
    if (role) this.members.set(key, role)
    else this.members.delete(key)
  }

  /** Sealed material only. Plaintext stays out of this view. */
  inspect(farmId: string): {
    access: SealedSecret
    refresh: SealedSecret | null
  } | null {
    const row = this.rows.get(farmId)
    if (!row) return null
    return {
      access: {
        ciphertext: Buffer.from(row.access.ciphertext),
        nonce: Buffer.from(row.access.nonce),
      },
      refresh: row.refresh
        ? {
            ciphertext: Buffer.from(row.refresh.ciphertext),
            nonce: Buffer.from(row.refresh.nonce),
          }
        : null,
    }
  }

  async member(actor: {
    farmId: string
    accountId: string
  }): Promise<MemberGate> {
    const role = this.members.get(`${actor.farmId}\0${actor.accountId}`)
    if (!role) return 'not-found'
    return role === 'owner' ? 'owner' : 'forbidden'
  }

  async read(farmId: string): Promise<StoredBambuCloudAccount | null> {
    const row = this.rows.get(farmId)
    if (!row) return null
    return {
      region: row.region,
      account: row.account,
      expiresAt: row.expiresAt,
      mqtt: row.mqtt,
    }
  }

  async write(
    farmId: string,
    accountId: string,
    draft: BambuCloudDraft,
  ): Promise<WriteGate> {
    const gate = await this.member({ farmId, accountId })
    if (gate !== 'owner') return gate
    try {
      const access = sealBambuCloudSecret(draft.accessToken, this.master)
      const refresh = draft.refreshToken
        ? sealBambuCloudSecret(draft.refreshToken, this.master)
        : null
      this.rows.set(farmId, {
        region: draft.region,
        account: draft.account,
        expiresAt: draft.expiresAt,
        mqtt: draft.mqtt,
        access,
        refresh,
      })
      return 'ok'
    } catch {
      return 'invalid-input'
    }
  }

  async remove(farmId: string, accountId: string): Promise<MemberGate | 'ok'> {
    const gate = await this.member({ farmId, accountId })
    if (gate !== 'owner') return gate
    this.rows.delete(farmId)
    return 'ok'
  }
}

type Deps = {
  now: Date
  logger: Logger
  policy?: unknown
  endpointFallback?: string | undefined
  fetchImpl?: typeof fetch | undefined
}

async function gateOwner(
  store: BambuCloudAccountStore,
  actor: { farmId: string; accountId: string },
  logger: Logger,
): Promise<BambuCloudConnectResult | null> {
  if (!actorOk(actor)) return { ok: false, reason: 'invalid-input' }
  const gate = await store.member(actor)
  if (gate === 'owner') return null
  if (gate !== 'storage-unavailable')
    logAccount(logger, 'bambu cloud account rejected', {
      farmId: actor.farmId,
      outcome: gate,
    })
  return { ok: false, reason: gate }
}

export async function readBambuCloudAccount(
  store: BambuCloudAccountStore,
  actor: { farmId: string; accountId: string },
  deps: Deps,
): Promise<BambuCloudConnectResult> {
  const denied = await gateOwner(store, actor, deps.logger)
  if (denied) return denied
  const row = await store.read(actor.farmId)
  if (row === 'storage-unavailable')
    return { ok: false, reason: 'storage-unavailable' }
  return { ok: true, account: bambuCloudAccountView(row, deps.now) }
}

export async function disconnectBambuCloudAccount(
  store: BambuCloudAccountStore,
  actor: { farmId: string; accountId: string },
  deps: Deps,
): Promise<BambuCloudConnectResult> {
  const denied = await gateOwner(store, actor, deps.logger)
  if (denied) return denied
  const removed = await store.remove(actor.farmId, actor.accountId)
  if (removed !== 'ok')
    return {
      ok: false,
      reason: removed === 'owner' ? 'storage-unavailable' : removed,
    }
  logAccount(deps.logger, 'bambu cloud account disconnected', {
    farmId: actor.farmId,
    connected: false,
    outcome: 'disconnected',
  })
  return { ok: true, account: { ...DISCONNECTED_BAMBU_CLOUD_ACCOUNT } }
}

export async function connectBambuCloudAccount(
  store: BambuCloudAccountStore,
  actor: { farmId: string; accountId: string },
  body: unknown,
  deps: Deps,
): Promise<BambuCloudConnectResult> {
  const denied = await gateOwner(store, actor, deps.logger)
  if (denied) return denied
  const request = parseBambuCloudConnectRequest(body)
  if (!request) return { ok: false, reason: 'invalid-input' }
  const policy = deps.policy ?? {}
  if (!isBambuCloudEnabled(policy)) {
    logAccount(deps.logger, 'bambu cloud account rejected', {
      farmId: actor.farmId,
      region: request.region,
      outcome: 'disabled',
    })
    return { ok: false, reason: 'cloud-disabled' }
  }
  let draft: BambuCloudDraft
  if (request.mode === 'token') {
    draft = {
      region: request.region,
      account: request.account,
      accessToken: request.accessToken,
      refreshToken: request.refreshToken ?? null,
      expiresAt: request.expiresAt,
      cloudOrigin: null,
      mqtt: null,
    }
  } else {
    const endpoint = request.endpoint ?? deps.endpointFallback
    if (!endpoint) return { ok: false, reason: 'cloud-rejected' }
    const login = await loginBambuCloud({
      endpoint,
      policy,
      now: deps.now,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      body:
        request.mode === 'email-code'
          ? { account: request.account, code: request.code }
          : request.mode === 'password'
            ? { account: request.account, password: request.password }
            : {
                account: request.account,
                tfaKey: request.tfaKey,
                tfaCode: request.tfaCode,
              },
    })
    if (!login.ok) {
      logAccount(deps.logger, 'bambu cloud account rejected', {
        farmId: actor.farmId,
        region: request.region,
        outcome:
          login.reason === 'cloud-disabled'
            ? 'disabled'
            : login.reason === 'cloud-unauthorized'
              ? 'unauthorized'
              : 'rejected',
      })
      return { ok: false, reason: login.reason }
    }
    if (login.kind === 'tfa') {
      logAccount(deps.logger, 'bambu cloud account rejected', {
        farmId: actor.farmId,
        region: request.region,
        outcome: 'tfa',
      })
      return { ok: true, tfaRequired: true, tfaKey: login.tfaKey }
    }
    draft = {
      region: request.region,
      account: request.account,
      accessToken: login.accessToken,
      refreshToken: login.refreshToken,
      expiresAt: login.expiresAt.toISOString(),
      cloudOrigin: endpoint,
      mqtt: login.mqtt,
    }
  }
  const saved = await store.write(actor.farmId, actor.accountId, draft)
  if (saved !== 'ok')
    return {
      ok: false,
      reason: saved === 'owner' ? 'storage-unavailable' : saved,
    }
  const account = bambuCloudAccountView(
    {
      region: draft.region,
      account: draft.account,
      expiresAt: draft.expiresAt,
      mqtt: draft.mqtt,
    },
    deps.now,
  )
  logAccount(deps.logger, 'bambu cloud account connected', {
    farmId: actor.farmId,
    region: account.region ?? undefined,
    expired: account.expired,
    connected: true,
    outcome: 'connected',
  })
  return { ok: true, account }
}
