import { readFileSync } from 'node:fs'
import { controlRoleAllowed } from '../../packages/farm-protocol/src/control-actions.ts'
import { describe, expect, it } from 'vitest'
import { detailTabs } from '../../apps/farm/app/utils/printer-detail-view.ts'
import { vendorDetailCatalog } from '../../apps/farm/app/utils/compatibility/detail-panels.ts'

describe('vendor detail panels', () => {
  it('lists configuration as unavailable when Bambu advertises files', () => {
    const { available, unavailable } = detailTabs(
      ['files'],
      {},
      vendorDetailCatalog.bambu,
    )

    expect(available.map(({ id }) => id)).toEqual(['painel', 'arquivos'])
    expect(unavailable).toContainEqual(
      expect.objectContaining({
        id: 'configuracao',
        reason: vendorDetailCatalog.bambu.reason,
      }),
    )
  })

  it('keeps configuration available for Moonraker with files', () => {
    expect(detailTabs(['files']).available.map(({ id }) => id)).toEqual([
      'painel',
      'arquivos',
      'configuracao',
    ])
  })
})

it('stores G-code capability under the same role rule as authorization', () => {
  const migration = readFileSync(
    new URL(
      '../../infra/db/migrations/0071_owner_gcode_capability.up.sql',
      import.meta.url,
    ),
    'utf8',
  )
  expect(migration).toContain(
    "ARRAY['run_macro','power','bed_mesh','gcode']) OR COALESCE(capability->>'role' IN ('owner','admin'), false)",
  )
  expect(migration).not.toContain("capability->'actions' ? 'gcode'")
  expect(
    ['owner', 'admin', 'operator', 'viewer'].filter((role) =>
      controlRoleAllowed(role, 'gcode'),
    ),
  ).toEqual(['owner', 'admin'])
})
