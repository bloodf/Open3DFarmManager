import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error The executable JavaScript helper has no declaration file.
import { buildArgs } from '../../scripts/docker-base-image.mjs'

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), 'utf8')

describe('issue 913 regressions', () => {
  it('revokes superseded entry points and restores them on rollback', () => {
    const up = read(
      '../../infra/db/migrations/0123_spool_observation_permissions.up.sql',
    )
    const down = read(
      '../../infra/db/migrations/0123_spool_observation_permissions.down.sql',
    )
    for (const name of [
      'lock_physical_spool_observations',
      'lock_physical_spool_observations_with_receipt',
      'read_physical_spool_observations_with_receipt',
    ]) {
      expect(up).toContain(`farm.${name}(uuid, uuid)`)
      expect(down).toContain(`farm.${name}(uuid, uuid)`)
    }
    expect(up).toMatch(/REVOKE EXECUTE[\s\S]+FROM farm_integration_apps/)
    expect(down).toMatch(/GRANT EXECUTE[\s\S]+TO farm_integration_apps/)
    expect(up).not.toContain('lock_physical_spool_observations_with_freshness')
  })
  it('checks nullable receipt timestamps against the safe integer range', () => {
    expect(
      read(
        '../../infra/db/migrations/0123_spool_observation_permissions.up.sql',
      ),
    ).toMatch(/CHECK\s*\(received_at BETWEEN 0 AND 9007199254740991\)/)
    expect(
      read(
        '../../infra/db/migrations/0123_spool_observation_permissions.down.sql',
      ),
    ).toContain(
      'DROP CONSTRAINT connector_inventory_snapshots_received_at_safe_integer',
    )
  })
  it('builds from the same image that the offline guard checks', () => {
    expect(
      buildArgs({
        tag: 'test',
        nodeImage: 'example:node',
        context: '/tmp/context',
      }),
    ).toContain('NODE_IMAGE=example:node')
    expect(read('../../infra/test-base/Dockerfile')).toMatch(
      /ARG NODE_IMAGE=[^\s]+\s+FROM \$\{NODE_IMAGE\}/,
    )
  })
  it('keeps vendor certificate crypto in shared code', () => {
    expect(
      existsSync(
        new URL(
          '../../packages/farm-protocol/src/kobra-client-cert.ts',
          import.meta.url,
        ),
      ),
    ).toBe(false)
    expect(
      existsSync(
        new URL(
          '../../packages/shared/src/kobra-client-cert.ts',
          import.meta.url,
        ),
      ),
    ).toBe(true)
  })
})
