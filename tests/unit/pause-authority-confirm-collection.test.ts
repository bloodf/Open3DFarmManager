import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'
import { loadMigrationCatalog } from '../../scripts/db/migrations.ts'
import {
  ExtendedControlAction,
  controlRoleAllowed,
} from '../../packages/farm-protocol/src/control-actions.ts'

const read = (name: string) =>
  readFile(
    new URL(`../../infra/db/migrations/${name}`, import.meta.url),
    'utf8',
  )

const PREVIOUS = '0073_config_write_capability.up.sql'
const UP = '0093_pause_authority_confirm_collection.up.sql'
const DOWN = '0093_pause_authority_confirm_collection.down.sql'

/** The action allow-list literal of a shipped constraint definition. */
function allowList(sql: string): string[] {
  const match = sql.match(/capability->'actions' <@ '(\[[^\]]*\])'::jsonb/)
  if (!match?.[1]) throw new Error('No action allow-list in the definition')
  return JSON.parse(match[1]) as string[]
}

const constraintLine = (sql: string) =>
  sql
    .split('\n')
    .find((line) =>
      line.includes('ADD CONSTRAINT control_capability_actions'),
    ) ?? ''

describe('migration 0093 pause authority confirm_collection', () => {
  test('is the next contiguous pair in the migration catalog', async () => {
    const catalog = await loadMigrationCatalog()
    const entry = catalog.find(
      (candidate) => candidate.id === '0093_pause_authority_confirm_collection',
    )
    expect(entry).toBeDefined()
    expect(catalog[92]?.id).toBe('0093_pause_authority_confirm_collection')
  })

  test('keeps every previous action and role rule and adds confirm_collection', async () => {
    const previous = await read(PREVIOUS)
    const up = await read(UP)
    const previousActions = allowList(previous)
    const actions = allowList(up)
    expect(previousActions).toHaveLength(31)
    expect(actions).toEqual([...previousActions, 'confirm_collection'])
    expect(up).toContain(
      'ALTER TABLE farm.pause_authority_challenges DROP CONSTRAINT control_capability_actions;',
    )
    expect(up).toContain(
      "NOT (capability->'actions' ?| ARRAY['run_macro','power','bed_mesh','gcode','config_write']) OR COALESCE(capability->>'role' IN ('owner','admin'), false)",
    )
    expect(up).toContain(
      "NOT (capability->'actions' ? 'service') OR COALESCE(capability->>'role' = 'owner', false)",
    )
  })

  test('the allow-list and the action bound match the signed control protocol', async () => {
    const up = await read(UP)
    const actions = allowList(up)
    expect([...actions].sort()).toEqual(
      [...ExtendedControlAction.options].sort(),
    )
    expect(up).toContain(
      `BETWEEN 1 AND ${ExtendedControlAction.options.length}`,
    )
    expect(ExtendedControlAction.options).toContain('confirm_collection')
  })

  test('the role rules match the role policy for every control action', async () => {
    const up = await read(UP)
    const roles = ['owner', 'admin', 'operator'] as const
    const groups = new Map<string, string[]>()
    for (const action of ExtendedControlAction.options) {
      const key = roles
        .filter((role) => controlRoleAllowed(role, action))
        .join(',')
      groups.set(key, [...(groups.get(key) ?? []), action])
    }
    expect([...groups.keys()].sort()).toEqual([
      'owner',
      'owner,admin',
      'owner,admin,operator',
    ])
    const ownerOnly = groups.get('owner') ?? []
    const elevated = groups.get('owner,admin') ?? []
    const defaults = groups.get('owner,admin,operator') ?? []
    expect(ownerOnly).toEqual(['service'])
    const literal = up.match(/\?\| ARRAY\[([^\]]*)\]/)?.[1] ?? ''
    const stored = literal
      .split(',')
      .map((value) => value.trim().replaceAll("'", ''))
      .filter(Boolean)
    expect([...stored].sort()).toEqual([...elevated].sort())
    for (const action of ownerOnly)
      expect(up).toContain(`capability->'actions' ? '${action}'`)
    // A default-tier action carries no extra role rule.
    for (const action of defaults)
      expect(up).not.toContain(`capability->'actions' ? '${action}'`)
    // confirm_collection is a default-tier action: owner, admin and operator
    // may hold it, exactly like the role policy.
    for (const role of roles)
      expect(controlRoleAllowed(role, 'confirm_collection')).toBe(true)
    expect(controlRoleAllowed('viewer', 'confirm_collection')).toBe(false)
    expect(up).not.toContain(`capability->'actions' ? 'confirm_collection'`)
  })

  test('the rollback restores the previous definition', async () => {
    const previous = await read(PREVIOUS)
    const down = await read(DOWN)
    expect(allowList(down)).toEqual(allowList(previous))
    expect(down).toContain('BETWEEN 1 AND 31')
    expect(down).toContain(constraintLine(previous))
  })

  test('the rollback refuses while a stored capability holds confirm_collection', async () => {
    const down = await read(DOWN)
    expect(down).toContain("capability->'actions' ? 'confirm_collection'")
    expect(down).toMatch(/RAISE EXCEPTION '[^']*confirm_collection[^']*'/)
    expect(down.indexOf('RAISE EXCEPTION')).toBeGreaterThan(-1)
    expect(down.indexOf('RAISE EXCEPTION')).toBeLessThan(
      down.indexOf('ADD CONSTRAINT control_capability_actions'),
    )
  })
})
