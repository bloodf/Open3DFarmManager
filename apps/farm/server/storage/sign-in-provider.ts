import type { Sql } from 'postgres'
import {
  GOOGLE_PROVIDER_ID,
  googlePublicView,
  googleSignInStatus,
  isInstallationAdmin,
  type GoogleProviderPublicView,
  type GoogleSignInStatus,
} from '../utils/google-provider-preset.ts'
import {
  openClientSecret,
  sealClientSecret,
  type SealedSecret,
} from '../utils/sign-in-provider-secret.ts'

export type SignInProviderRecord = {
  enabled: boolean
  clientId: string
  sealedSecret: SealedSecret | null
}

export type SignInProviderStore = {
  /** Admin read. Returns null when the actor is not an installation admin. */
  adminGet(
    actorId: string,
    origin: string,
  ): Promise<GoogleProviderPublicView | null>
  /** Admin write. Returns null when the actor is not an installation admin. */
  adminPut(
    actorId: string,
    origin: string,
    update: {
      enabled: boolean
      clientId: string
      clientSecret?: string
    },
  ): Promise<GoogleProviderPublicView | null>
  /** Public status for the sign-in page. Never returns credentials. */
  publicStatus(offline?: boolean): Promise<GoogleSignInStatus>
  /**
   * Ready credentials for the Google callback/start path.
   * Null when off or incomplete. Does not remove linked identities when off.
   */
  runtimeCredentials(): Promise<{
    clientId: string
    clientSecret: string
    issuer: string
  } | null>
}

type Row = {
  enabled: boolean
  client_id: string
  client_secret_ciphertext: Buffer | null
  client_secret_nonce: Buffer | null
}

function toRecord(row: Row | undefined): SignInProviderRecord {
  if (!row) return { enabled: false, clientId: '', sealedSecret: null }
  const sealed =
    row.client_secret_ciphertext && row.client_secret_nonce
      ? {
          ciphertext: Buffer.from(row.client_secret_ciphertext),
          nonce: Buffer.from(row.client_secret_nonce),
        }
      : null
  return {
    enabled: row.enabled === true,
    clientId: typeof row.client_id === 'string' ? row.client_id : '',
    sealedSecret: sealed,
  }
}

function viewFrom(
  record: SignInProviderRecord,
  origin: string,
): GoogleProviderPublicView {
  return googlePublicView({
    origin,
    enabled: record.enabled,
    clientId: record.clientId,
    hasClientSecret: record.sealedSecret !== null,
  })
}

export class MemorySignInProviderStore implements SignInProviderStore {
  private record: SignInProviderRecord = {
    enabled: false,
    clientId: '',
    sealedSecret: null,
  }
  private readonly admins = new Set<string>()
  private readonly roles = new Map<string, string>()

  private readonly master: string
  private readonly issuer: string

  constructor(master: string, issuer = 'https://accounts.google.com') {
    this.master = master
    this.issuer = issuer
  }

  /** Test helper: grant or refuse installation-admin access. */
  setActor(actorId: string, role: string | null): void {
    this.roles.set(actorId, role ?? '')
    if (role && isInstallationAdmin(role)) this.admins.add(actorId)
    else this.admins.delete(actorId)
  }

  /** Test helper: inspect sealed material without exposing plaintext. */
  inspect(): SignInProviderRecord {
    return {
      enabled: this.record.enabled,
      clientId: this.record.clientId,
      sealedSecret: this.record.sealedSecret
        ? {
            ciphertext: Buffer.from(this.record.sealedSecret.ciphertext),
            nonce: Buffer.from(this.record.sealedSecret.nonce),
          }
        : null,
    }
  }

  async adminGet(
    actorId: string,
    origin: string,
  ): Promise<GoogleProviderPublicView | null> {
    if (!this.admins.has(actorId)) return null
    return viewFrom(this.record, origin)
  }

  async adminPut(
    actorId: string,
    origin: string,
    update: {
      enabled: boolean
      clientId: string
      clientSecret?: string
    },
  ): Promise<GoogleProviderPublicView | null> {
    if (!this.admins.has(actorId)) return null
    let sealed = this.record.sealedSecret
    if (update.clientSecret !== undefined) {
      sealed = sealClientSecret(update.clientSecret, this.master)
    }
    if (update.enabled && (update.clientId === '' || sealed === null))
      return null
    this.record = {
      enabled: update.enabled,
      clientId: update.clientId,
      sealedSecret: sealed,
    }
    return viewFrom(this.record, origin)
  }

  async publicStatus(offline = false): Promise<GoogleSignInStatus> {
    return googleSignInStatus({
      enabled: this.record.enabled,
      clientId: this.record.clientId,
      hasClientSecret: this.record.sealedSecret !== null,
      offline,
    })
  }

  async runtimeCredentials(): Promise<{
    clientId: string
    clientSecret: string
    issuer: string
  } | null> {
    const status = await this.publicStatus(false)
    if (!status.enabled || !this.record.sealedSecret) return null
    return {
      clientId: this.record.clientId,
      clientSecret: openClientSecret(this.record.sealedSecret, this.master),
      issuer: this.issuer,
    }
  }
}

export class PostgresSignInProviderStore implements SignInProviderStore {
  private readonly sql: Sql
  private readonly master: string

  constructor(sql: Sql, master: string) {
    this.sql = sql
    this.master = master
  }

  private async actorIsAdmin(tx: Sql, actorId: string): Promise<boolean> {
    const rows = await tx`SELECT m.role FROM farm.memberships m
        JOIN farm.session_accounts a ON a.id = m.account_id
        WHERE m.account_id = ${actorId}
          AND m.revoked_at IS NULL
          AND NOT a.disabled
          AND m.role IN ('owner', 'admin')
        LIMIT 1
        FOR SHARE OF m, a`
    const role = rows[0]?.role
    return typeof role === 'string' && isInstallationAdmin(role)
  }

  private async load(tx: Sql): Promise<SignInProviderRecord> {
    const rows = await tx<Row[]>`
      SELECT enabled, client_id, client_secret_ciphertext, client_secret_nonce
      FROM farm.sign_in_providers WHERE id = ${GOOGLE_PROVIDER_ID} FOR UPDATE`
    return toRecord(rows[0])
  }

  async adminGet(
    actorId: string,
    origin: string,
  ): Promise<GoogleProviderPublicView | null> {
    return await this.sql.begin(async (tx) => {
      await tx`SET LOCAL statement_timeout = '2000ms'`
      await tx`SET LOCAL lock_timeout = '1000ms'`
      if (!(await this.actorIsAdmin(tx as unknown as Sql, actorId))) return null
      return viewFrom(await this.load(tx as unknown as Sql), origin)
    })
  }

  async adminPut(
    actorId: string,
    origin: string,
    update: {
      enabled: boolean
      clientId: string
      clientSecret?: string
    },
  ): Promise<GoogleProviderPublicView | null> {
    return await this.sql.begin(async (tx) => {
      await tx`SET LOCAL statement_timeout = '2000ms'`
      await tx`SET LOCAL lock_timeout = '1000ms'`
      if (!(await this.actorIsAdmin(tx as unknown as Sql, actorId))) return null
      const current = await this.load(tx as unknown as Sql)
      let sealed = current.sealedSecret
      if (update.clientSecret !== undefined) {
        sealed = sealClientSecret(update.clientSecret, this.master)
      }
      if (update.enabled && (update.clientId === '' || sealed === null))
        return null
      await tx`
        INSERT INTO farm.sign_in_providers (
          id, enabled, client_id, client_secret_ciphertext, client_secret_nonce, updated_by
        ) VALUES (
          ${GOOGLE_PROVIDER_ID},
          ${update.enabled},
          ${update.clientId},
          ${sealed ? sealed.ciphertext : null},
          ${sealed ? sealed.nonce : null},
          ${actorId}
        )
        ON CONFLICT (id) DO UPDATE SET
          enabled = EXCLUDED.enabled,
          client_id = EXCLUDED.client_id,
          client_secret_ciphertext = EXCLUDED.client_secret_ciphertext,
          client_secret_nonce = EXCLUDED.client_secret_nonce,
          updated_at = clock_timestamp(),
          updated_by = EXCLUDED.updated_by`
      return viewFrom(
        {
          enabled: update.enabled,
          clientId: update.clientId,
          sealedSecret: sealed,
        },
        origin,
      )
    })
  }

  async publicStatus(offline = false): Promise<GoogleSignInStatus> {
    const rows = await this.sql<Row[]>`
      SELECT enabled, client_id, client_secret_ciphertext, client_secret_nonce
      FROM farm.sign_in_providers WHERE id = ${GOOGLE_PROVIDER_ID}`
    const record = toRecord(rows[0])
    return googleSignInStatus({
      enabled: record.enabled,
      clientId: record.clientId,
      hasClientSecret: record.sealedSecret !== null,
      offline,
    })
  }

  async runtimeCredentials(): Promise<{
    clientId: string
    clientSecret: string
    issuer: string
  } | null> {
    const rows = await this.sql<Row[]>`
      SELECT enabled, client_id, client_secret_ciphertext, client_secret_nonce
      FROM farm.sign_in_providers WHERE id = ${GOOGLE_PROVIDER_ID}`
    const record = toRecord(rows[0])
    const status = googleSignInStatus({
      enabled: record.enabled,
      clientId: record.clientId,
      hasClientSecret: record.sealedSecret !== null,
    })
    if (!status.enabled || !record.sealedSecret) return null
    return {
      clientId: record.clientId,
      clientSecret: openClientSecret(record.sealedSecret, this.master),
      issuer: 'https://accounts.google.com',
    }
  }
}
