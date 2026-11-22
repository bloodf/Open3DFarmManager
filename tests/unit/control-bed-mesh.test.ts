// SPDX-License-Identifier: MIT
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  ControlArguments,
  ExtendedControlAction,
  controlRoleAllowed,
  controlSourceState,
  type ExtendedControlAction as Action,
} from '../../packages/farm-protocol/src/control-actions.ts'
import { PrinterDetailStreamUpdate } from '../../packages/farm-protocol/src/printer-detail.ts'
import {
  claimCommand,
  closeCommandJournal,
  finishCommand,
  openCommandJournal,
  readCommandAction,
} from '../../packages/connector/src/control/command-journal.ts'
import { createPrinterBindingRegistry } from '../../packages/connector/src/control/printer-binding.ts'
import {
  BedMeshRefused,
  bedMeshScript,
  parseBedMeshState,
  refuseBedMesh,
  type BedMeshState,
} from '../../packages/connector/src/moonraker/control-bed-mesh.ts'
import { buildMoonrakerCommand } from '../../packages/connector/src/moonraker/commands.ts'
import { moonrakerControls } from '../../packages/connector/src/moonraker/control-support.ts'
import { normalizeDetail } from '../../packages/connector/src/moonraker/detail-normalize.ts'
import { openFixedMoonrakerPause } from '../../packages/connector/src/moonraker/pause-driver.ts'
import { actionsForControlRole } from '../../apps/farm/server/utils/pause-authority/role-policy.ts'
import { startMoonrakerMock } from '../../packages/sim-tools/src/mocks/moonraker-mock.ts'
import type { MoonrakerMockOptions } from '../../packages/sim-tools/src/mocks/moonraker-mock.ts'

const idle: BedMeshState = {
  ready: true,
  printState: 'standby',
  homedAxes: 'xyz',
  profiles: ['default', 'cold'],
  hasMesh: true,
}

describe('bed_mesh arguments', () => {
  it.each([
    { op: 'calibrate' },
    { op: 'calibrate', profile: 'cold_bed' },
    { op: 'load', profile: 'default' },
    { op: 'save', profile: 'a'.repeat(32) },
    { op: 'remove', profile: 'old_1' },
    { op: 'clear' },
  ])('accepts %j', (args) => {
    expect(
      ControlArguments.safeParse({ action: 'bed_mesh', args }).success,
    ).toBe(true)
  })
  it.each([
    { op: 'load' },
    { op: 'save' },
    { op: 'remove' },
    { op: 'clear', profile: 'default' },
    { op: 'calibrate', profile: 'a'.repeat(33) },
    { op: 'calibrate', profile: 'with space' },
    { op: 'calibrate', profile: 'x;M112' },
    { op: 'calibrate', profile: '' },
    { op: 'reset' },
    { op: 'calibrate', x: 10 },
    {},
  ])('rejects %j', (args) => {
    expect(
      ControlArguments.safeParse({ action: 'bed_mesh', args }).success,
    ).toBe(false)
  })
  it('is owner or admin only and runs only while stopped', () => {
    expect(ExtendedControlAction.options).toContain('bed_mesh')
    expect(controlRoleAllowed('owner', 'bed_mesh')).toBe(true)
    expect(controlRoleAllowed('admin', 'bed_mesh')).toBe(true)
    expect(controlRoleAllowed('operator', 'bed_mesh')).toBe(false)
    expect(controlRoleAllowed('viewer', 'bed_mesh')).toBe(false)
    expect(actionsForControlRole('operator', ['bed_mesh', 'jog'])).toEqual([
      'jog',
    ])
    expect(controlSourceState('bed_mesh', 'idle')).toBe(true)
    for (const state of ['printing', 'paused', 'error', 'unknown'])
      expect(controlSourceState('bed_mesh', state)).toBe(false)
  })
})

describe('bed_mesh scripts', () => {
  it('builds one script per op from validated arguments', () => {
    expect(bedMeshScript({ op: 'calibrate' })).toBe('BED_MESH_CALIBRATE')
    expect(bedMeshScript({ op: 'calibrate', profile: 'cold' })).toBe(
      'BED_MESH_CALIBRATE PROFILE=cold',
    )
    expect(bedMeshScript({ op: 'load', profile: 'cold' })).toBe(
      'BED_MESH_PROFILE LOAD=cold',
    )
    expect(bedMeshScript({ op: 'save', profile: 'cold' })).toBe(
      'BED_MESH_PROFILE SAVE=cold',
    )
    expect(bedMeshScript({ op: 'remove', profile: 'cold' })).toBe(
      'BED_MESH_PROFILE REMOVE=cold',
    )
    expect(bedMeshScript({ op: 'clear' })).toBe('BED_MESH_CLEAR')
  })
  it('never injects text from a profile', () => {
    for (const profile of ['a b', 'a\nM112', 'a;M112', '../x'])
      expect(() => bedMeshScript({ op: 'save', profile })).toThrow(
        BedMeshRefused,
      )
  })
  it('goes through the Moonraker command builder and is advertised by object', () => {
    expect(
      buildMoonrakerCommand('bed_mesh', { op: 'clear' }, ['bed_mesh']),
    ).toEqual({
      method: 'printer.gcode.script',
      params: { script: 'BED_MESH_CLEAR' },
    })
    expect(() =>
      buildMoonrakerCommand('bed_mesh', { op: 'clear' }, ['toolhead']),
    ).toThrow()
    expect(moonrakerControls(['toolhead', 'bed_mesh'])).toContain('bed_mesh')
    expect(moonrakerControls(['toolhead'])).not.toContain('bed_mesh')
    expect(moonrakerControls(undefined)).not.toContain('bed_mesh')
  })
})

describe('bed_mesh refusals', () => {
  const refusal = (args: unknown, state: BedMeshState | undefined) => {
    try {
      refuseBedMesh(args, state)
    } catch (error) {
      return (error as BedMeshRefused).refusal
    }
    return undefined
  }
  it('allows every op on an idle, homed printer with a mesh and profiles', () => {
    for (const args of [
      { op: 'calibrate' },
      { op: 'load', profile: 'cold' },
      { op: 'save', profile: 'new' },
      { op: 'remove', profile: 'cold' },
      { op: 'clear' },
    ])
      expect(refusal(args, idle), JSON.stringify(args)).toBeUndefined()
  })
  it.each(['printing', 'paused', 'error'])(
    'refuses every op while %s',
    (printState) => {
      for (const args of [
        { op: 'calibrate' },
        { op: 'load', profile: 'cold' },
        { op: 'clear' },
      ])
        expect(refusal(args, { ...idle, printState })).toBe('state')
    },
  )
  it('refuses calibration unless X, Y and Z are all homed', () => {
    for (const homedAxes of ['', 'x', 'xy', 'yz'])
      expect(refusal({ op: 'calibrate' }, { ...idle, homedAxes })).toBe('state')
    expect(refusal({ op: 'clear' }, { ...idle, homedAxes: '' })).toBeUndefined()
  })
  it('refuses load and remove of a profile the printer does not list', () => {
    expect(refusal({ op: 'load', profile: 'nope' }, idle)).toBe('state')
    expect(refusal({ op: 'remove', profile: 'nope' }, idle)).toBe('state')
  })
  it('refuses to save when there is no mesh', () => {
    expect(
      refusal({ op: 'save', profile: 'new' }, { ...idle, hasMesh: false }),
    ).toBe('state')
  })
  it('refuses with no, unready or unreadable state', () => {
    expect(refusal({ op: 'clear' }, undefined)).toBe('state')
    expect(refusal({ op: 'clear' }, { ...idle, ready: false })).toBe('state')
    expect(() => parseBedMeshState({ status: {} })).toThrow(BedMeshRefused)
    expect(() => parseBedMeshState(null)).toThrow(BedMeshRefused)
  })
  it('refuses malformed arguments', () => {
    expect(refusal({ op: 'load' }, idle)).toBe('invalid-command')
  })
})

const limits = {
  maxMessageBytes: 65536,
  connectTimeoutMs: 500,
  requestTimeoutMs: 500,
  staleAfterMs: 2000,
  reconnectMinMs: 100,
  reconnectMaxMs: 100,
}
let monotonic = 0
const clock = { monotonicNow: () => (monotonic += 0.001) }

/** The E16 Moonraker mock on 127.0.0.1 with an ephemeral port. */
async function withMock<T>(
  options: MoonrakerMockOptions,
  run: (
    mock: Awaited<ReturnType<typeof startMoonrakerMock>>,
    attempt: (
      action: Action,
      args: Record<string, unknown>,
    ) => Promise<{ ok: boolean; error?: unknown; guard: number }>,
  ) => Promise<T>,
): Promise<T> {
  const mock = await startMoonrakerMock(options)
  try {
    const binding = createPrinterBindingRegistry({
      allowedOrigins: [mock.origin],
    }).provision({
      assignment_id: randomUUID(),
      farm_id: randomUUID(),
      agent_id: randomUUID(),
      printer_key: 'printer-mesh',
      moonraker_origin: mock.origin,
    })
    const { detectMoonrakerObjects } =
      await import('../../packages/connector/src/moonraker/control-support.ts')
    const detected = await detectMoonrakerObjects({
      binding,
      allowedOrigins: [mock.origin],
      limits,
      signal: new AbortController().signal,
    })
    const attempt = async (action: Action, args: Record<string, unknown>) => {
      const owner = new AbortController()
      let guard = 0
      const fixed = openFixedMoonrakerPause({
        binding,
        allowedOrigins: [mock.origin],
        limits,
        connectionGeneration: 1,
        clock,
        publish: () => {},
        signal: owner.signal,
        objects: detected,
      })
      try {
        await fixed.prepare()
        await fixed.driver.execute!(action, args, {
          binding,
          beforeSend: () => {
            guard++
            return true
          },
          signal: owner.signal,
        })
        return { ok: true, guard }
      } catch (error) {
        return { ok: false, error, guard }
      } finally {
        await fixed.close()
      }
    }
    return await run(mock, attempt)
  } finally {
    await mock.close()
  }
}

const homeAll = { axes: ['x', 'y', 'z'] }
const refused = (result: { error?: unknown }) =>
  (result.error as BedMeshRefused).refusal

describe('Moonraker bed_mesh driver on the E16 mock', () => {
  it('calibrates then saves with one script each', async () => {
    await withMock({}, async (mock, attempt) => {
      expect((await attempt('home', homeAll)).ok).toBe(true)
      expect(
        await attempt('bed_mesh', { op: 'calibrate', profile: 'cold' }),
      ).toMatchObject({ ok: true, guard: 1 })
      expect(mock.control.gcodeScripts.at(-1)).toBe(
        'BED_MESH_CALIBRATE PROFILE=cold',
      )
      expect(
        (await attempt('bed_mesh', { op: 'save', profile: 'warm' })).ok,
      ).toBe(true)
      expect(mock.control.gcodeScripts.at(-1)).toBe(
        'BED_MESH_PROFILE SAVE=warm',
      )
    })
  })

  it('loads, removes and clears once a profile exists', async () => {
    await withMock({}, async (mock, attempt) => {
      await attempt('home', homeAll)
      expect(
        (await attempt('bed_mesh', { op: 'save', profile: 'cold' })).ok,
      ).toBe(true)
      const ops = [
        [{ op: 'load', profile: 'cold' }, 'BED_MESH_PROFILE LOAD=cold'],
        [{ op: 'remove', profile: 'cold' }, 'BED_MESH_PROFILE REMOVE=cold'],
        [{ op: 'clear' }, 'BED_MESH_CLEAR'],
      ] as const
      for (const [args, script] of ops) {
        const result = await attempt('bed_mesh', args)
        expect(result, script).toMatchObject({ ok: true, guard: 1 })
        expect(mock.control.gcodeScripts.at(-1)).toBe(script)
      }
    })
  })

  it('calibrates without a profile name', async () => {
    await withMock({}, async (mock, attempt) => {
      await attempt('home', homeAll)
      expect((await attempt('bed_mesh', { op: 'calibrate' })).ok).toBe(true)
      expect(mock.control.gcodeScripts.at(-1)).toBe('BED_MESH_CALIBRATE')
    })
  })

  it('refuses calibration unhomed and writes nothing', async () => {
    await withMock({ homedAxes: '' }, async (mock, attempt) => {
      const result = await attempt('bed_mesh', { op: 'calibrate' })
      expect(result).toMatchObject({ ok: false, guard: 0 })
      expect(refused(result)).toBe('state')
      expect(mock.control.gcodeScripts).toEqual([])
    })
  })

  it.each(['printing', 'paused'] as const)(
    'refuses every op while %s',
    async (state) => {
      await withMock({ initial: { state } }, async (mock, attempt) => {
        for (const args of [
          { op: 'calibrate' },
          { op: 'load', profile: 'default' },
          { op: 'clear' },
        ]) {
          const result = await attempt('bed_mesh', args)
          expect(result).toMatchObject({ ok: false, guard: 0 })
          expect(refused(result)).toBe('state')
        }
        expect(mock.control.gcodeScripts).toEqual([])
      })
    },
  )

  it('refuses load and remove of an unknown profile and save without a mesh', async () => {
    await withMock(
      { bedMeshProfiles: [{ name: 'empty', points: [] }] },
      async (mock, attempt) => {
        for (const args of [
          { op: 'load', profile: 'nope' },
          { op: 'remove', profile: 'nope' },
          { op: 'save', profile: 'new' },
        ]) {
          const result = await attempt('bed_mesh', args)
          expect(result, JSON.stringify(args)).toMatchObject({
            ok: false,
            guard: 0,
          })
          expect(refused(result)).toBe('state')
        }
        expect(mock.control.gcodeScripts).toEqual([])
      },
    )
  })

  it('refuses on a printer that lists no bed_mesh', async () => {
    await withMock(
      { objects: ['webhooks', 'print_stats', 'toolhead'] },
      async (mock, attempt) => {
        const result = await attempt('bed_mesh', { op: 'clear' })
        expect(result).toMatchObject({ ok: false, guard: 0 })
        expect(refused(result)).toBe('unsupported-action')
        expect(mock.control.gcodeScripts).toEqual([])
      },
    )
  })

  it('refuses malformed arguments before any write', async () => {
    await withMock({}, async (mock, attempt) => {
      const result = await attempt('bed_mesh', { op: 'save', profile: 'a b' })
      expect(result).toMatchObject({ ok: false, guard: 0 })
      expect(refused(result)).toBe('invalid-command')
      expect(mock.control.gcodeScripts).toEqual([])
    })
  })
})

describe('bed mesh read path', () => {
  const mesh = {
    profile_name: 'default',
    mesh_min: [10, 10],
    mesh_max: [210, 210],
    probed_matrix: [
      [0, 0.1],
      [0.1, 0],
    ],
    mesh_matrix: [
      [0, 0.05, 0.1],
      [0.05, 0.05, 0.05],
      [0.1, 0.05, 0],
    ],
    profiles: { default: { points: [] }, cold: { points: [] } },
  }
  it('carries probed points and profile names in the detail frame', () => {
    const { detail, capabilities } = normalizeDetail(
      new Map([['bed_mesh', mesh]]),
    )
    expect(capabilities).toContain('bed-mesh')
    expect(detail.bedMesh).toMatchObject({
      profile: 'default',
      probed: mesh.probed_matrix,
      profiles: ['default', 'cold'],
    })
    expect(
      PrinterDetailStreamUpdate.safeParse({
        v: 1,
        t: 'detail.update',
        printerKey: 'printer-mesh',
        seq: 1,
        capabilities,
        detail,
      }).success,
    ).toBe(true)
  })
  it('keeps saved profiles available after clearing the active mesh', () => {
    const { detail } = normalizeDetail(
      new Map([
        [
          'bed_mesh',
          { ...mesh, profile_name: '', mesh_matrix: [], probed_matrix: [] },
        ],
      ]),
    )
    expect(detail.bedMesh).toMatchObject({
      profile: null,
      rows: [],
      profiles: ['default', 'cold'],
    })
  })
  it('omits probed points and profiles the printer does not report', () => {
    const { detail } = normalizeDetail(
      new Map([['bed_mesh', { ...mesh, probed_matrix: [], profiles: {} }]]),
    )
    expect(detail.bedMesh).not.toHaveProperty('probed')
    expect(detail.bedMesh).not.toHaveProperty('profiles')
  })
})

describe('command journal', () => {
  it('migrates a v6 journal and records bed_mesh', () => {
    // Scratch directory under the OS temp area; left in place on purpose.
    const directory = mkdtempSync(join(tmpdir(), 'bed-mesh-journal-'))
    closeCommandJournal(openCommandJournal({ directory, clock: Date.now }))
    const db = new DatabaseSync(join(directory, 'pause-commands.sqlite'))
    try {
      db.exec(
        "DROP INDEX pause_active_assignment; DROP INDEX pause_active_printer; CREATE UNIQUE INDEX pause_active_assignment ON pause_commands(assignment_id) WHERE status IN ('claimed','write-started','outcome-unknown'); CREATE UNIQUE INDEX pause_active_printer ON pause_commands(farm_id,printer_key) WHERE status IN ('claimed','write-started','outcome-unknown'); DROP TABLE control_command_actions; CREATE TABLE control_command_actions (cmd_id TEXT PRIMARY KEY, action TEXT NOT NULL CHECK(action IN ('pause','resume','cancel','emergency_stop','firmware_restart','run_macro','load_filament','unload_filament','extrude','set_led','set_pin','jog','motors_off','z_babystep','set_factor','set_temperature','set_fan','home','set_light','set_speed','start_print'))) STRICT; INSERT INTO control_command_actions VALUES ('retained', 'set_pin'); PRAGMA user_version=6;",
      )
    } finally {
      db.close()
    }
    const journal = openCommandJournal({ directory, clock: Date.now })
    try {
      expect(readCommandAction(journal, 'retained')).toBe('set_pin')
    } finally {
      closeCommandJournal(journal)
    }
    const migrated = new DatabaseSync(join(directory, 'pause-commands.sqlite'))
    try {
      migrated
        .prepare('INSERT INTO control_command_actions VALUES (?,?)')
        .run('mesh', 'bed_mesh')
      expect(() =>
        migrated.exec(
          "INSERT INTO control_command_actions VALUES ('invalid', 'invalid')",
        ),
      ).toThrow()
    } finally {
      migrated.close()
    }
  })
})

describe('bed_mesh rate limit', () => {
  it('accepts one dispatch per printer a minute and leaves other actions alone', () => {
    // Scratch directory under the OS temp area; left in place on purpose.
    const directory = mkdtempSync(join(tmpdir(), 'bed-mesh-rate-'))
    let now = 1000
    const journal = openCommandJournal({ directory, clock: () => now })
    const scope = {
      farm_id: randomUUID(),
      agent_id: randomUUID(),
      account_id: 'text_account',
      key_id: randomUUID(),
      transport_id: randomUUID(),
      capability_id: randomUUID(),
    }
    const claim = (
      action: 'bed_mesh' | 'motors_off',
      printerKey = 'printer-1',
    ) =>
      claimCommand(journal, {
        command: {
          v: 2 as const,
          purpose: 'printer-control' as const,
          cmd_id: randomUUID(),
          ...scope,
          assignment_id: randomUUID(),
          action,
          args: action === 'bed_mesh' ? { op: 'clear' } : {},
          issued_at: now,
          expires_at: now + 5000,
          nonce: randomBytes(16).toString('base64url'),
          sig: 'A'.repeat(86),
        } as never,
        printerKey,
        wireSha256: randomBytes(32).toString('hex'),
      })
    const settle = (result: ReturnType<typeof claim>) => {
      if (!result.ok) throw new Error(result.reason)
      expect(
        finishCommand(journal, result.receipt, 'not-sent', 'not-sent'),
      ).toBe(true)
    }
    try {
      settle(claim('bed_mesh'))
      expect(claim('bed_mesh')).toEqual({ ok: false, reason: 'rate-limited' })
      settle(claim('motors_off'))
      settle(claim('bed_mesh', 'printer-2'))
      now += 61_000
      settle(claim('bed_mesh'))
    } finally {
      closeCommandJournal(journal)
    }
  })
})
