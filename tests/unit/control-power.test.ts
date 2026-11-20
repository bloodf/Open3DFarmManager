import { chmodSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  closeCommandJournal,
  openCommandJournal,
  readCommandAction,
} from '../../packages/connector/src/control/command-journal.ts'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  ControlArguments,
  controlRoleAllowed,
} from '../../packages/farm-protocol/src/control-actions.ts'
import { createPrinterBindingRegistry } from '../../packages/connector/src/control/printer-binding.ts'
import { openFixedMoonrakerPause } from '../../packages/connector/src/moonraker/pause-driver.ts'
import {
  detectMoonrakerObjects,
  detectMoonrakerComponents,
  moonrakerControls,
} from '../../packages/connector/src/moonraker/control-support.ts'
import {
  authorizePower,
  POWER_MARKER,
  POWER_METHOD,
} from '../../packages/connector/src/moonraker/control-power.ts'
import { startMoonrakerMock } from '../../packages/sim-tools/src/mocks/moonraker-mock.ts'

const off = { device: 'printer', on: false }
const unlocked = {
  devices: [{ device: 'printer', status: 'on', locked_while_printing: false }],
}
const objects = [POWER_MARKER, 'extruder']

describe('signed power control', () => {
  it('accepts only explicit device and boolean state for owners and admins', () => {
    expect(ControlArguments.parse({ action: 'power', args: off }).args).toEqual(
      off,
    )
    expect(
      ControlArguments.safeParse({
        action: 'power',
        args: { ...off, extra: 1 },
      }).success,
    ).toBe(false)
    for (const role of ['owner', 'admin'])
      expect(controlRoleAllowed(role, 'power')).toBe(true)
    for (const role of ['operator', 'viewer'])
      expect(controlRoleAllowed(role, 'power')).toBe(false)
    expect(moonrakerControls([])).not.toContain('power')
  })

  it.each([
    ['printing', 0, 0],
    ['paused', 0, 0],
    ['standby', 200, 0],
    ['standby', 0, 0.5],
    ['standby', undefined, 0],
  ])(
    'refuses off for state %s, target %s and heater power %s',
    async (state, target, power) => {
      const read = vi.fn(async (method: string) =>
        method === POWER_METHOD
          ? unlocked
          : { status: { print_stats: { state }, extruder: { target, power } } },
      )
      await expect(authorizePower(off, objects, read)).rejects.toMatchObject({
        refusal: 'state',
      })
    },
  )

  it('refuses locked, unlisted and unadvertised devices', async () => {
    const read = vi.fn(async () => ({
      devices: [{ ...unlocked.devices[0], locked_while_printing: true }],
    }))
    await expect(authorizePower(off, [], read)).rejects.toMatchObject({
      refusal: 'unsupported-action',
    })
    expect(read).not.toHaveBeenCalled()
    await expect(
      authorizePower({ ...off, on: true }, objects, read),
    ).rejects.toMatchObject({ refusal: 'state' })
    await expect(
      authorizePower({ ...off, device: 'other' }, objects, read),
    ).rejects.toMatchObject({ refusal: 'unsupported-action' })
  })

  it.each([
    { on: false, target: 0, allowed: true },
    { on: true, target: 0, allowed: true },
    { on: false, target: 200, allowed: false },
  ])(
    'uses the E16 mock for on=$on and target=$target',
    async ({ on, target, allowed }) => {
      const mock = await startMoonrakerMock({
        initial: { extruderTarget: target },
        objects: ['print_stats', 'webhooks', 'extruder', 'heater_bed'],
        // The E16 default relay locks while printing; this one does not.
        powerDevices: [
          { device: 'printer', status: 'off', locked_while_printing: false },
        ],
      })
      onTestFinished(() => mock.close())
      const allowedOrigins = [mock.origin]
      const binding = createPrinterBindingRegistry({
        allowedOrigins,
      }).provision({
        assignment_id: randomUUID(),
        farm_id: randomUUID(),
        agent_id: randomUUID(),
        printer_key: 'printer-power',
        moonraker_origin: mock.origin,
      })
      const signal = new AbortController().signal
      const shared = {
        binding,
        allowedOrigins,
        signal,
        limits: {
          maxMessageBytes: 65536,
          connectTimeoutMs: 1000,
          requestTimeoutMs: 1000,
          staleAfterMs: 2000,
          reconnectMinMs: 100,
          reconnectMaxMs: 100,
        },
      }
      const detected = [
        ...(await detectMoonrakerObjects(shared)),
        ...(await detectMoonrakerComponents(shared)),
      ]
      expect(moonrakerControls(detected)).toContain('power')
      const fixed = openFixedMoonrakerPause({
        ...shared,
        objects: detected,
        connectionGeneration: 1,
        clock: { monotonicNow: () => performance.now() },
        publish: () => {},
      })
      try {
        await fixed.prepare()
        const beforeSend = vi.fn(() => true)
        const result = fixed.driver.execute!(
          'power',
          { ...off, on },
          { binding, beforeSend, signal },
        )
        if (allowed) {
          await expect(result).resolves.toEqual({ acknowledged: true })
          expect(beforeSend).toHaveBeenCalledTimes(1)
        } else {
          await expect(result).rejects.toMatchObject({ refusal: 'state' })
          expect(beforeSend).not.toHaveBeenCalled()
        }
        expect(
          mock.calls.all
            .filter(
              ({ method }) => method === 'machine.device_power.post_device',
            )
            .map(({ params }) => params),
        ).toEqual(
          allowed ? [{ device: 'printer', action: on ? 'on' : 'off' }] : [],
        )
      } finally {
        await fixed.close()
      }
    },
  )
})

it.each([
  { version: 9, action: 'power', actions: "'power'" },
  { version: 9, action: 'exclude_object', actions: "'exclude_object'" },
  { version: 10, action: 'power', actions: "'exclude_object','power'" },
  { version: 10, action: 'timelapse', actions: "'exclude_object','timelapse'" },
])(
  'upgrades the v$version journal and preserves $action',
  ({ version, action, actions }) => {
    const directory = mkdtempSync(
      join(process.env.OPENFARM_POWER_TEST_TMP ?? tmpdir(), 'power-journal-'),
    )
    chmodSync(directory, 0o700)
    closeCommandJournal(openCommandJournal({ directory, clock: Date.now }))
    const db = new DatabaseSync(join(directory, 'pause-commands.sqlite'))
    try {
      const row = db
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE name='control_command_actions'",
        )
        .get()
      if (typeof row?.sql !== 'string') throw new Error('Missing action table')
      const prior = row.sql
        .replace(",'start_library_print'", '')
        .replace(",'config_write'", '')
        .replace("'set_factor','file_op'", "'set_factor'")
        .replace(
          "'service','exclude_object','timelapse','power'",
          `'service',${actions}`,
        )
      db.exec(
        `DROP TABLE control_command_actions; ${prior}; PRAGMA user_version=${version};`,
      )
      db.prepare('INSERT INTO control_command_actions VALUES (?, ?)').run(
        'retained',
        action,
      )
    } finally {
      db.close()
    }
    const journal = openCommandJournal({ directory, clock: Date.now })
    try {
      expect(readCommandAction(journal, 'retained')).toBe(action)
    } finally {
      closeCommandJournal(journal)
    }
  },
)
