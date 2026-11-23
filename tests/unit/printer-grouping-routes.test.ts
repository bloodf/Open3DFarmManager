import { readFileSync } from 'node:fs'
import type { Sql } from 'postgres'
import { describe, expect, test, vi } from 'vitest'
import { withNetworkGuard } from '../../packages/sim-tools/src/mocks/network-guard.ts'
import { printerAssignments } from '../../apps/farm/server/services/printer-assignments.ts'
import { printerStates } from '../../apps/farm/server/services/printer-states.ts'
import { PostgresPrinterOwnership } from '../../apps/farm/server/storage/postgres-printer-ownership.ts'
import type { AuthRuntime } from '../../apps/farm/server/utils/auth/runtime.ts'

vi.mock('../../apps/farm/server/services/authenticated-session.ts', () => ({
  authResponse: vi.fn(),
  authenticatedSession: vi.fn(),
  sealedSessionRecordId: () => 'grouping-session',
}))

const farmId = '11111111-1111-4111-8111-111111111111'
const agentId = '22222222-2222-4222-8222-222222222222'
const assignmentId = '33333333-3333-4333-8333-333333333333'
const printerKey = 'moonraker-test'
const origin = 'https://127.0.0.1'
const grouping = {
  displayName: 'Mesa 1',
  groupName: 'Protótipos',
  location: null,
  sortOrder: 0,
}

function fixture(
  role: string,
  options: { revoked?: boolean; duplicate?: boolean } = {},
) {
  const write = vi.fn()
  const tx = Object.assign(
    async (parts: TemplateStringsArray, ...args: unknown[]) => {
      const statement = parts.join('?').trim()
      if (statement.includes('FROM farm.session_accounts'))
        return [{ id: 'account', sessionVersion: 0, disabled: false }]
      if (statement.includes('FROM farm.account_sessions'))
        return [
          {
            id: 'grouping-session',
            accountId: 'account',
            accountVersion: 0,
            createdAt: 0,
            lastSeenAt: 10,
            absoluteExpiresAt: 1000,
            revokedAt: null,
          },
        ]
      if (statement.includes('FROM farm.memberships')) {
        expect(args[0]).toBe(farmId)
        return [{ role, revoked_at: null }]
      }
      if (statement.includes('FROM farm.connector_enrollments'))
        return [{ status: 'approved' }]
      if (statement.includes('FROM farm.printer_assignments')) {
        expect(args).toContain(farmId)
        expect(args).toContain(assignmentId)
        return [{ id: assignmentId, revoked_at: options.revoked ? 12 : null }]
      }
      if (statement.startsWith('UPDATE farm.printer_assignments')) {
        if (options.duplicate)
          throw Object.assign(new Error('duplicate'), { code: '23505' })
        write(...args)
      }
      return []
    },
    {
      savepoint: (action: (sql: unknown) => unknown): unknown => action(tx),
    },
  )
  const sql = {
    begin: (action: (sql: unknown) => unknown) => action(tx),
  } as unknown as Sql
  const auth = {
    origin,
    idleTimeoutMs: 100,
    credentials: { consumeLimit: async () => true },
  } as unknown as AuthRuntime
  const ownership = new PostgresPrinterOwnership(sql, () => 20)
  const inventory = {
    list: async () => ({
      ok: true as const,
      printers: [
        {
          assignmentId,
          agentId,
          printerKey,
          status: 'active' as const,
          connectorStatus: 'approved' as const,
          ...grouping,
        },
      ],
      nextAfter: null,
      canManage: role === 'owner' || role === 'admin',
    }),
  }
  return {
    write,
    edit: (
      payload = { agentId, printerKey, ...grouping },
      requestOrigin = origin,
    ) =>
      withNetworkGuard(() =>
        printerAssignments(
          {
            req: new Request(origin + '/grouping', {
              method: 'POST',
              headers: {
                origin: requestOrigin,
                'content-type': 'application/json',
              },
              body: JSON.stringify(payload),
            }),
            res: { headers: new Headers() },
          } as Parameters<typeof printerAssignments>[0],
          'edit',
          { farmId, assignmentId },
          {
            auth,
            runtime: { inventory, ownership },
          },
        ),
      ),
    list: () =>
      withNetworkGuard(() =>
        printerAssignments(
          {
            req: new Request(origin + '/printers'),
            res: { headers: new Headers() },
          } as Parameters<typeof printerAssignments>[0],
          'list',
          { farmId },
          {
            auth,
            runtime: { inventory, ownership },
          },
        ),
      ),
  }
}

describe('printer grouping', () => {
  test.each(['owner', 'admin'])(
    '%s can save nullable grouping metadata',
    async (role) => {
      const route = fixture(role)
      await expect(route.edit()).resolves.toEqual({
        assignmentId,
        status: 'active',
      })
      expect(route.write).toHaveBeenCalledExactlyOnceWith(
        'Mesa 1',
        'Protótipos',
        null,
        0,
        assignmentId,
      )
    },
  )

  test('a member cannot edit and owners cannot edit tombstones', async () => {
    for (const route of [
      fixture('operator'),
      fixture('owner', { revoked: true }),
    ]) {
      await expect(route.edit()).rejects.toMatchObject({ status: 403 })
      expect(route.write).not.toHaveBeenCalled()
    }
  })

  test('rejects a foreign origin and out-of-range sort order', async () => {
    const route = fixture('owner')
    await expect(
      route.edit(undefined, 'https://other.invalid'),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      route.edit({ agentId, printerKey, ...grouping, sortOrder: 10000 }),
    ).rejects.toMatchObject({ status: 400 })
    expect(route.write).not.toHaveBeenCalled()
  })

  test('a duplicate name returns a conflict', async () => {
    await expect(
      fixture('owner', { duplicate: true }).edit(),
    ).rejects.toMatchObject({
      status: 409,
      message: 'Já existe uma impressora com este nome na farm.',
    })
  })

  test('assignment and latest-state responses expose the metadata to members', async () => {
    await expect(fixture('operator').list()).resolves.toMatchObject({
      printers: [{ assignmentId, ...grouping }],
      canManage: false,
    })
    const event = {
      req: new Request(origin + '/printer-states'),
      res: { headers: new Headers() },
    } as Parameters<typeof printerStates>[0]
    await expect(
      withNetworkGuard(() =>
        printerStates(event, farmId, {
          auth: { idleTimeoutMs: 100 } as AuthRuntime,
          reader: {
            list: async () => ({
              ok: true,
              states: [
                {
                  assignmentId,
                  printerKey,
                  ...grouping,
                  state: 'idle',
                  observedAt: 20,
                  progress: undefined,
                  toolTemperatureCelsius: undefined,
                  bedTemperatureCelsius: undefined,
                },
              ],
            }),
          },
        }),
      ),
    ).resolves.toMatchObject({ states: [{ assignmentId, ...grouping }] })
  })

  test('migration adds nullable fields and rolls back its grants, index and fields', () => {
    const migrations = new URL('../../infra/db/migrations/', import.meta.url)
    const up = readFileSync(
      new URL('0070_printer_grouping.up.sql', migrations),
      'utf8',
    )
    const down = readFileSync(
      new URL('0070_printer_grouping.down.sql', migrations),
      'utf8',
    )
    const previous = readFileSync(
      new URL('0015_printer_ownership.up.sql', migrations),
      'utf8',
    )
    for (const column of [
      'display_name',
      'group_name',
      'location',
      'sort_order',
    ]) {
      expect(up).toContain('ADD COLUMN ' + column)
      expect(down).toContain('DROP COLUMN ' + column)
    }
    expect(up).toMatch(
      /\(farm_id, display_name\)\s+WHERE display_name IS NOT NULL/,
    )
    expect(up).toContain(
      'GRANT UPDATE (display_name, group_name, location, sort_order)',
    )
    expect(up).not.toContain(
      'REVOKE UPDATE (display_name, group_name, location, sort_order)',
    )
    expect(up).toContain('OLD.revoked_at IS NULL AND NEW.revoked_at IS NULL')
    expect(down).toContain('DROP INDEX farm.printer_assignments_display_name')
    expect(down).toContain(
      'REVOKE UPDATE (display_name, group_name, location, sort_order)',
    )
    const functionBody = (sql: string) =>
      sql
        .match(/BEGIN[\s\S]*?\nEND;\s*\$\$;/)?.[0]
        .replace(/\s+/g, ' ')
        .replace(/\( /g, '(')
        .replace(/ \)/g, ')')
    expect(functionBody(down)).toBe(functionBody(previous))
  })
})
