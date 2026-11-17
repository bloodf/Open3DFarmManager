import type { Sql } from 'postgres'
import { z } from 'zod'
import {
  MAX_TRUSTED_BROWSER_KEYS,
  TrustedBrowserKey,
  type TrustedIssuerKey,
} from '../../../../../packages/farm-protocol/src/trusted-keys.ts'
import { BrowserDeviceUuid } from '../../../../../packages/farm-protocol/src/browser-device-proof.ts'
import type { TrustedKeyRow, TrustedKeySource } from './publisher.ts'

const Row = TrustedBrowserKey.extend({ farm_id: BrowserDeviceUuid })

/**
 * Approved browser keys of one farm whose account still has a live membership.
 * One more row than the cap is read so an oversize farm fails closed upstream.
 * Issuer keys are the server's own pinned set (not per-farm rows).
 */
export function createPostgresTrustedKeySource(
  sql: Sql,
  issuerKeys: readonly TrustedIssuerKey[],
): TrustedKeySource {
  return Object.freeze({
    async read(farmId: string) {
      const farm = BrowserDeviceUuid.parse(farmId)
      const rows = await sql`
        SELECT k.key_id::text AS key_id, k.farm_id::text AS farm_id,
          k.account_id, k.thumbprint, k.public_key
        FROM farm.browser_device_keys k
        JOIN farm.memberships m
          ON m.farm_id = k.farm_id AND m.account_id = k.account_id
        WHERE k.farm_id = ${farm}::uuid AND k.status = 'approved'
          AND m.revoked_at IS NULL
        ORDER BY k.key_id LIMIT ${MAX_TRUSTED_BROWSER_KEYS + 1}`
      const browserKeys: TrustedKeyRow[] = z
        .array(Row)
        .parse(rows)
        .map(({ farm_id, ...key }) => ({ ...key, farmId: farm_id }))
      return { issuerKeys, browserKeys }
    },
  })
}
