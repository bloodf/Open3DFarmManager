import postgres, { type Sql } from 'postgres'
import type { BambuCloudMqtt } from './cloud-client.ts'
import {
  type BambuCloudAccountStore,
  type BambuCloudDraft,
  type BambuRegion,
  type StoredBambuCloudAccount,
} from './account.ts'
import { sealBambuCloudSecret } from './secret.ts'

type MemberGate = 'owner' | 'forbidden' | 'not-found' | 'storage-unavailable'

function mqttOf(
  host: string | null,
  port: number | null,
  username: string | null,
): BambuCloudMqtt | null {
  if (
    (host !== '127.0.0.1' && host !== 'localhost') ||
    port === null ||
    username === null
  )
    return null
  return { host, port, username }
}

export class PostgresBambuCloudAccountStore implements BambuCloudAccountStore {
  constructor(
    private readonly sql: Sql,
    private readonly master: string,
  ) {}

  private async memberOf(
    tx: Sql,
    farmId: string,
    accountId: string,
  ): Promise<MemberGate> {
    const members = await tx<{ role: string; revoked_at: string | null }[]>`
      SELECT role, revoked_at FROM farm.memberships
      WHERE farm_id = ${farmId}::uuid AND account_id = ${accountId}
      FOR SHARE`
    const member = members[0]
    if (!member || member.revoked_at !== null) return 'not-found'
    return member.role === 'owner' ? 'owner' : 'forbidden'
  }

  async member(actor: {
    farmId: string
    accountId: string
  }): Promise<MemberGate> {
    try {
      return await this.sql.begin(async (tx) =>
        this.memberOf(tx as unknown as Sql, actor.farmId, actor.accountId),
      )
    } catch {
      return 'storage-unavailable'
    }
  }

  async read(
    farmId: string,
  ): Promise<StoredBambuCloudAccount | null | 'storage-unavailable'> {
    try {
      const rows = await this.sql<
        {
          region: BambuRegion
          account: string
          expiresAt: Date
          mqttHost: string | null
          mqttPort: number | null
          mqttUsername: string | null
        }[]
      >`
        SELECT region, account_name AS account, expires_at AS "expiresAt",
          mqtt_host AS "mqttHost", mqtt_port AS "mqttPort",
          mqtt_username AS "mqttUsername"
        FROM farm.bambu_cloud_accounts
        WHERE farm_id = ${farmId}::uuid`
      const row = rows[0]
      if (!row) return null
      return {
        region: row.region,
        account: row.account,
        expiresAt: row.expiresAt.toISOString(),
        mqtt: mqttOf(row.mqttHost, row.mqttPort, row.mqttUsername),
      }
    } catch {
      return 'storage-unavailable'
    }
  }

  async write(farmId: string, accountId: string, draft: BambuCloudDraft) {
    let access
    let refresh: { ciphertext: Buffer; nonce: Buffer } | null
    try {
      access = sealBambuCloudSecret(draft.accessToken, this.master)
      refresh = draft.refreshToken
        ? sealBambuCloudSecret(draft.refreshToken, this.master)
        : null
    } catch {
      return 'invalid-input' as const
    }
    try {
      return await this.sql.begin(async (tx) => {
        const gate = await this.memberOf(
          tx as unknown as Sql,
          farmId,
          accountId,
        )
        if (gate !== 'owner') return gate
        const query = tx as unknown as Sql
        await query`
          INSERT INTO farm.bambu_cloud_accounts (
            farm_id, region, account_name, access_ciphertext, access_nonce,
            refresh_ciphertext, refresh_nonce, expires_at, cloud_origin,
            mqtt_host, mqtt_port, mqtt_username, updated_by
          ) VALUES (
            ${farmId}::uuid, ${draft.region}, ${draft.account},
            ${access.ciphertext}, ${access.nonce},
            ${refresh ? refresh.ciphertext : null},
            ${refresh ? refresh.nonce : null},
            ${draft.expiresAt}::timestamptz, ${draft.cloudOrigin},
            ${draft.mqtt ? draft.mqtt.host : null},
            ${draft.mqtt ? draft.mqtt.port : null},
            ${draft.mqtt ? draft.mqtt.username : null},
            ${accountId}
          )
          ON CONFLICT (farm_id) DO UPDATE SET
            region = EXCLUDED.region,
            account_name = EXCLUDED.account_name,
            access_ciphertext = EXCLUDED.access_ciphertext,
            access_nonce = EXCLUDED.access_nonce,
            refresh_ciphertext = EXCLUDED.refresh_ciphertext,
            refresh_nonce = EXCLUDED.refresh_nonce,
            expires_at = EXCLUDED.expires_at,
            cloud_origin = EXCLUDED.cloud_origin,
            mqtt_host = EXCLUDED.mqtt_host,
            mqtt_port = EXCLUDED.mqtt_port,
            mqtt_username = EXCLUDED.mqtt_username,
            updated_at = clock_timestamp(),
            updated_by = EXCLUDED.updated_by`
        return 'ok' as const
      })
    } catch {
      return 'storage-unavailable' as const
    }
  }

  async remove(farmId: string, accountId: string) {
    try {
      return await this.sql.begin(async (tx) => {
        const gate = await this.memberOf(
          tx as unknown as Sql,
          farmId,
          accountId,
        )
        if (gate !== 'owner') return gate
        await (tx as unknown as Sql)`
          DELETE FROM farm.bambu_cloud_accounts WHERE farm_id = ${farmId}::uuid`
        return 'ok' as const
      })
    } catch {
      return 'storage-unavailable' as const
    }
  }
}

let pool: ReturnType<typeof postgres> | undefined
let store: PostgresBambuCloudAccountStore | undefined

export function bambuCloudDatabaseStore(
  databaseUrl: string,
  master: string,
): BambuCloudAccountStore {
  if (store) return store
  const url = new URL(databaseUrl)
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.username ||
    !url.password ||
    url.pathname.length < 2
  )
    throw new Error('invalid bambu cloud database url')
  const sql = postgres(url.toString(), {
    max: 3,
    connect_timeout: 3,
    idle_timeout: 20,
    connection: { statement_timeout: 2000, lock_timeout: 1000 },
  })
  pool = sql
  store = new PostgresBambuCloudAccountStore(sql, master)
  return store
}

export async function closeBambuCloudDatabaseStore() {
  const closing = pool
  pool = undefined
  store = undefined
  await closing?.end({ timeout: 3 })
}
