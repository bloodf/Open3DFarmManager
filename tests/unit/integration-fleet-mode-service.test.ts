import { describe, expect, it } from 'vitest'
import type {
  IntegrationPrincipal,
  IntegrationPrinterRow,
} from '../../apps/farm/server/utils/integration-auth.ts'
import {
  changeFleetMode,
  fleetModeRequest,
  type FleetModeRecord,
  type FleetModeStore,
} from '../../apps/farm/server/utils/integration-fleet-mode.ts'

const printerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const farmId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const appId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const grantId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const now = 1700000000000
const principal: IntegrationPrincipal = {
  appId,
  scopes: ['control:extended'],
  grants: [
    {
      id: grantId,
      appId,
      farmId,
      printerAssignmentId: printerId,
      scopes: ['control:extended'],
      requiresApproval: false,
      createdAt: now,
      disabledAt: null,
      disabledReason: null,
    },
  ],
}
const printer: IntegrationPrinterRow = {
  id: printerId,
  farmId,
  printerKey: 'sample',
  sandbox: true,
  observedAt: now,
  // Spec-derived, not captured.
  state: {
    printerKey: 'sample',
    state: 'idle',
    progress: 0,
    observedAt: now,
    identity: {
      vendor: 'Klipper',
      model: 'Moonraker Generic',
      firmware: 'Moonraker 2.0.0',
    },
    controls: ['pause', 'resume', 'cancel', 'start_print'],
  },
}
const set = fleetModeRequest.parse({
  action: 'set',
  mode: 'maintenance',
  targets: [{ printerId, expectedVersion: null }],
})

function fixture(row = printer) {
  let current: FleetModeRecord | null = null
  const store: FleetModeStore = {
    read: async () => current,
    compareAndSet: async ({ expectedVersion, next }) => {
      if ((current?.version ?? null) !== expectedVersion) return false
      current = next
      return true
    },
  }
  return {
    change: (request = set, caller = principal) =>
      changeFleetMode(caller, async () => row, store, request, now),
    current: () => current,
  }
}

describe('integration fleet mode', () => {
  it('allows only one concurrent submission for an expected version', async () => {
    const { change, current } = fixture()
    const outcomes = await Promise.all([change(), change()])
    expect(
      outcomes
        .flatMap((result) => result?.data.map(({ outcome }) => outcome))
        .sort(),
    ).toEqual(['applied', 'denied'])
    expect(current()?.mode).toBe('maintenance')
  })

  it('refuses reversal after a later change and does not conflate unknown state with availability', async () => {
    const { change, current } = fixture()
    await change()
    const version = current()!.version
    await change(
      fleetModeRequest.parse({
        action: 'set',
        mode: 'in-service',
        targets: [{ printerId, expectedVersion: version }],
      }),
    )
    expect(
      await change(
        fleetModeRequest.parse({
          action: 'restore',
          targets: [{ printerId, expectedVersion: version }],
        }),
      ),
    ).toMatchObject({
      data: [{ outcome: 'denied', reason: 'version-conflict' }],
    })
    expect(await fixture({ ...printer, state: null }).change()).toMatchObject({
      data: [{ outcome: 'denied', reason: 'observation-unavailable' }],
    })
  })

  it('requires advertised and qualified capability', async () => {
    const missingCapability = {
      ...printer,
      state: { ...(printer.state as object), controls: ['pause'] },
    }
    expect(await fixture(missingCapability).change()).toMatchObject({
      data: [{ outcome: 'unsupported', reason: 'capability-unqualified' }],
    })
    expect(
      await fixture({ ...printer, observedAt: now - 60_001 }).change(),
    ).toMatchObject({
      data: [{ outcome: 'denied', reason: 'observation-unavailable' }],
    })
  })

  it('honors approval-only and absent grants without attempting a write', async () => {
    const { change, current } = fixture()
    expect(
      await change(set, {
        ...principal,
        grants: [{ ...principal.grants[0]!, requiresApproval: true }],
      }),
    ).toMatchObject({
      data: [{ outcome: 'denied', reason: 'approval-required' }],
    })
    expect(await change(set, { ...principal, grants: [] })).toBeNull()
    expect(current()).toBeNull()
  })

  it('rejects duplicate target IDs and restores without a version', () => {
    expect(
      fleetModeRequest.safeParse({
        ...set,
        targets: [
          { printerId, expectedVersion: null },
          { printerId: printerId.toUpperCase(), expectedVersion: null },
        ],
      }).success,
    ).toBe(false)
    expect(
      fleetModeRequest.safeParse({
        action: 'restore',
        targets: [{ printerId, expectedVersion: null }],
      }).success,
    ).toBe(false)
  })
})

it('qualifies the availability change using capabilities from the loopback simulator', async () => {
  const { startMoonrakerMock } =
    await import('../../packages/sim-tools/src/mocks/moonraker-mock.ts')
  const { supportedMoonrakerActions } =
    await import('../../packages/connector/src/moonraker/commands.ts')
  const { appendFileSync } = await import('node:fs')
  const ledger = process.env.FLEET_MODE_TEST_LEDGER
  const mock = await startMoonrakerMock({ objects: ['virtual_sdcard'] })
  try {
    if (ledger)
      appendFileSync(ledger, `Started Moonraker fixture ${mock.origin}\n`)
    const reply = await fetch(`${mock.origin}/printer/objects/list`, {
      signal: AbortSignal.timeout(3000),
    })
    expect(reply.ok).toBe(true)
    const {
      result: { objects },
    } = (await reply.json()) as { result: { objects: string[] } }
    const observed = {
      ...printer,
      state: {
        ...(printer.state as object),
        controls: supportedMoonrakerActions(objects),
      },
    }
    expect(await fixture(observed).change()).toMatchObject({
      data: [{ outcome: 'applied', mode: 'maintenance' }],
    })
    expect(mock.control.gcodeScripts).toHaveLength(0)
  } finally {
    await mock.close()
    if (ledger)
      appendFileSync(ledger, `Stopped Moonraker fixture ${mock.origin}\n`)
  }
})
