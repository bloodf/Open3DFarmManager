import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderFarmComponent } from '../helpers/render-farm-component.ts'
import { withBrowser } from '../helpers/browser.ts'

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ')

describe('Spoolman observation lock order', () => {
  it('locks snapshots before settings in all binding entry points and the writer', () => {
    const migration = read(
      '../../infra/db/migrations/0121_spoolman_observation_lock_order.up.sql',
    )
    const [provenance, freshness, receipt, legacy] = migration.split('$$;')
    expect(provenance).toMatch(
      /JOIN farm\.connector_inventory_snapshots s .* ORDER BY e\.agent_id FOR SHARE OF e, s \) INTO locked_agents; PERFORM 1 FROM farm\.spoolman_connector_settings c .* ORDER BY c\.agent_id FOR SHARE;/,
    )
    const selection = provenance?.split('RETURN QUERY')[1]
    expect(selection).toContain('e.agent_id = ANY (locked_agents)')
    expect(selection).not.toMatch(/FOR (SHARE|UPDATE|KEY SHARE|NO KEY UPDATE)/)
    for (const [statement, suffix, requireDeclared] of [
      [freshness, '_with_freshness', false],
      [receipt, '_with_receipt', false],
      [legacy, '', true],
    ] as const) {
      expect(statement).toContain(
        'FUNCTION farm.lock_physical_spool_observations' + suffix + '(',
      )
      expect(statement).toContain(
        `FROM farm.lock_spool_observation_provenance(p_farm_id, p_service_id, ${requireDeclared})`,
      )
    }

    const writer = read(
      '../../apps/farm/server/storage/postgres-inventory-snapshot.ts',
    ).split('type Binding')[0]
    expect(writer).toMatch(
      /INSERT INTO farm\.connector_inventory_snapshots .* ON CONFLICT \(farm_id, agent_id\) DO UPDATE SET/,
    )
    expect(writer).not.toContain('spoolman_connector_settings')
    const trigger = read(
      '../../infra/db/migrations/0118_spoolman_effective_service_id.up.sql',
    )
    expect(trigger).toMatch(
      /FUNCTION farm\.record_observed_spoolman_service_id\(\).*UPDATE farm\.spoolman_connector_settings.*AFTER INSERT OR UPDATE OF snapshot ON farm\.connector_inventory_snapshots FOR EACH ROW EXECUTE FUNCTION farm\.record_observed_spoolman_service_id\(\)/,
    )
  })
})

it('announces the FarmSlot level once for printer, Spoolman and unknown levels', async () => {
  const cases = [
    { label: 'Impressora', printerPercent: 40, expected: '40' },
    { label: 'Spoolman', spoolmanPercent: 60, expected: '60' },
    {
      label: 'Peso',
      spoolmanRemainingWeight: 250,
      spoolmanInitialWeight: 1000,
      expected: '25',
    },
    { label: 'Sem nível', expected: null },
  ]
  const slots = await Promise.all(
    cases.map(({ expected: _expected, ...props }) =>
      renderFarmComponent('../spool-art/FarmSlot.vue', {
        material: 'PLA',
        ...props,
      }),
    ),
  )
  await withBrowser({}, async (browser) => {
    const page = await browser.newPage()
    await page.setContent(slots.join('\n'))
    for (const [index, { expected }] of cases.entries()) {
      const slot = page.getByRole('article').nth(index)
      const tree = await slot.ariaSnapshot()
      const meter = slot.getByRole('meter', { name: 'Filamento restante' })
      if (expected === null) {
        expect(await meter.count()).toBe(0)
        expect(tree.match(/desconhecid[oa]/g)).toHaveLength(1)
        expect(tree).toContain('img "Filamento restante: desconhecido"')
      } else {
        expect(await meter.count()).toBe(1)
        expect(await meter.getAttribute('aria-valuenow')).toBe(expected)
        expect(tree).not.toMatch(new RegExp(expected + '\\s*%'))
      }
    }
    await page.close()
  })
})
