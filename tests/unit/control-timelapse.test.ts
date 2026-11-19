// SPDX-License-Identifier: MIT
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  ControlArguments,
  ExtendedControlAction,
  TimelapseArguments,
  controlRoleAllowed,
  controlSourceState,
  type ExtendedControlAction as Action,
} from '../../packages/farm-protocol/src/control-actions.ts'
import {
  closeCommandJournal,
  openCommandJournal,
  readCommandAction,
} from '../../packages/connector/src/control/command-journal.ts'
import { controlWithinLimits } from '../../packages/connector/src/runtime/control-limits.ts'
import { createPrinterBindingRegistry } from '../../packages/connector/src/control/printer-binding.ts'
import {
  TIMELAPSE_COMPONENT_MARKER,
  TimelapseRefused,
  parseTimelapseOp,
  parseTimelapseStatus,
  refuseTimelapseOp,
  timelapseMarkers,
  timelapseReplyAccepted,
  timelapseSupported,
} from '../../packages/connector/src/moonraker/control-timelapse.ts'
import { buildMoonrakerCommand } from '../../packages/connector/src/moonraker/commands.ts'
import {
  detectMoonrakerComponents,
  detectMoonrakerObjects,
  moonrakerControls,
} from '../../packages/connector/src/moonraker/control-support.ts'
import { openFixedMoonrakerPause } from '../../packages/connector/src/moonraker/pause-driver.ts'
import { renderFarmComponent } from '../../apps/farm/app/components/farm/render-farm-component.ts'
import { actionsForControlRole } from '../../apps/farm/server/utils/pause-authority/role-policy.ts'
import { startMoonrakerMock } from '../../packages/sim-tools/src/mocks/moonraker-mock.ts'
import type { MoonrakerMockOptions } from '../../packages/sim-tools/src/mocks/moonraker-mock.ts'

const MARKED = ['toolhead', TIMELAPSE_COMPONENT_MARKER]

describe('timelapse arguments', () => {
  it.each([{ op: 'render' }, { op: 'delete', file: 'timelapse_1.mp4' }])(
    'accepts %j',
    (args) => {
      expect(TimelapseArguments.safeParse(args).success).toBe(true)
      expect(
        ControlArguments.safeParse({ action: 'timelapse', args }).success,
      ).toBe(true)
      expect(controlWithinLimits('timelapse', args)).toBe(true)
    },
  )

  it.each([
    {},
    { op: 'render', file: 'a.mp4' },
    { op: 'delete' },
    { op: 'delete', file: '' },
    { op: 'delete', file: '../config/printer.cfg' },
    { op: 'delete', file: 'pasta/a.mp4' },
    { op: 'delete', file: 'a\\b.mp4' },
    { op: 'delete', file: 'a\nb.mp4' },
    { op: 'delete', file: '..' },
    { op: 'delete', file: 'x'.repeat(256) },
    { op: 'settings' },
    { op: 'delete', file: 'a.mp4', extra: 1 },
  ])('rejects %j', (args) => {
    expect(TimelapseArguments.safeParse(args).success).toBe(false)
    expect(controlWithinLimits('timelapse', args)).toBe(false)
  })
})

describe('timelapse policy', () => {
  it('is an extended action for operator or higher, not for viewers', () => {
    expect(ExtendedControlAction.options).toContain('timelapse')
    for (const role of ['owner', 'admin', 'operator'])
      expect(controlRoleAllowed(role, 'timelapse')).toBe(true)
    for (const role of ['viewer', 'guest', ''])
      expect(controlRoleAllowed(role, 'timelapse')).toBe(false)
    expect(actionsForControlRole('operator')).not.toContain('timelapse')
    expect(
      actionsForControlRole('operator', ['timelapse'] as Action[]),
    ).toEqual(['timelapse'])
    expect(actionsForControlRole('viewer', ['timelapse'] as Action[])).toEqual(
      [],
    )
  })

  it('is refused while the state is unknown or in error', () => {
    for (const state of ['idle', 'printing', 'paused', 'cancelled'])
      expect(controlSourceState('timelapse', state)).toBe(true)
    for (const state of ['unknown', 'error'])
      expect(controlSourceState('timelapse', state)).toBe(false)
  })
})

describe('timelapse adapter', () => {
  it('maps render and delete to one validated call each', () => {
    expect(parseTimelapseOp({ op: 'render' }).call).toEqual({
      method: 'server.timelapse.render',
    })
    expect(
      buildMoonrakerCommand(
        'timelapse',
        { op: 'delete', file: 'a b.mp4' },
        MARKED,
      ),
    ).toEqual({
      method: 'server.files.delete_file',
      params: { path: 'timelapse/a b.mp4' },
    })
  })

  it('refuses invalid arguments and a missing plugin before building', () => {
    expect(() => parseTimelapseOp({ op: 'delete', file: '../x' })).toThrow(
      TimelapseRefused,
    )
    expect(() =>
      buildMoonrakerCommand('timelapse', { op: 'render' }, []),
    ).toThrow('Timelapse unavailable')
    expect(() =>
      buildMoonrakerCommand('timelapse', { op: 'render' }, ['toolhead']),
    ).toThrow('Timelapse unavailable')
    expect(() =>
      buildMoonrakerCommand('timelapse', { op: 'bad' }, MARKED),
    ).toThrow()
  })

  it('refuses from the live state and never guesses', () => {
    const render = { op: 'render' } as const
    const del = { op: 'delete', file: 'a.mp4' } as const
    const idle = parseTimelapseStatus(render, { enabled: true })
    const busy = parseTimelapseStatus(render, { rendering: true })
    const listing = parseTimelapseStatus(del, [{ path: 'a.mp4' }])
    expect(() => refuseTimelapseOp(render, idle)).not.toThrow()
    expect(() => refuseTimelapseOp(render, busy)).toThrow(TimelapseRefused)
    expect(() => refuseTimelapseOp(render, undefined)).toThrow(TimelapseRefused)
    expect(() => refuseTimelapseOp(render, listing)).toThrow(TimelapseRefused)
    expect(() => refuseTimelapseOp(del, listing)).not.toThrow()
    expect(() =>
      refuseTimelapseOp({ op: 'delete', file: 'b.mp4' }, listing),
    ).toThrow(TimelapseRefused)
    expect(() => parseTimelapseStatus(render, 'x')).toThrow(TimelapseRefused)
    expect(() => parseTimelapseStatus(del, { path: 'a.mp4' })).toThrow(
      TimelapseRefused,
    )
  })

  it('accepts only the documented acknowledgement', () => {
    expect(
      timelapseReplyAccepted({ op: 'render' }, { status: 'success' }),
    ).toBe(true)
    expect(timelapseReplyAccepted({ op: 'render' }, 'ok')).toBe(true)
    expect(timelapseReplyAccepted({ op: 'render' }, { status: 'x' })).toBe(
      false,
    )
    expect(
      timelapseReplyAccepted(
        { op: 'delete', file: 'a.mp4' },
        { action: 'delete_file' },
      ),
    ).toBe(true)
    expect(
      timelapseReplyAccepted(
        { op: 'delete', file: 'a.mp4' },
        { status: 'success' },
      ),
    ).toBe(false)
    expect(timelapseReplyAccepted({ op: 'render' }, null)).toBe(false)
  })

  it('reads the marker from server.info only', () => {
    expect(timelapseMarkers({ components: ['timelapse', 'history'] })).toEqual([
      TIMELAPSE_COMPONENT_MARKER,
    ])
    expect(timelapseMarkers({ components: ['history'] })).toEqual([])
    expect(timelapseMarkers('nope')).toEqual([])
    expect(timelapseSupported(MARKED)).toBe(true)
    expect(timelapseSupported(['toolhead'])).toBe(false)
    expect(timelapseSupported(undefined)).toBe(false)
  })

  it('advertises timelapse only with the marker', () => {
    expect(moonrakerControls(MARKED)).toContain('timelapse')
    expect(moonrakerControls(['toolhead'])).not.toContain('timelapse')
    expect(moonrakerControls(undefined)).not.toContain('timelapse')
    expect(moonrakerControls([])).not.toContain('timelapse')
  })
})

const limits = {
  maxMessageBytes: 4096,
  connectTimeoutMs: 500,
  requestTimeoutMs: 500,
  staleAfterMs: 2000,
  reconnectMinMs: 100,
  reconnectMaxMs: 100,
}
let monotonic = 0
const clock = { monotonicNow: () => (monotonic += 0.001) }
type Mock = Awaited<ReturnType<typeof startMoonrakerMock>>
type Attempt = (
  args: Record<string, unknown>,
) => Promise<{ ok: boolean; error?: unknown; guard: number }>

/** The E16 Moonraker mock on 127.0.0.1 with an ephemeral port. */
async function withMock<T>(
  options: MoonrakerMockOptions,
  run: (
    mock: Mock,
    attempt: Attempt,
    detected: readonly string[],
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
      printer_key: 'printer-timelapse',
      moonraker_origin: mock.origin,
    })
    const detect = {
      binding,
      allowedOrigins: [mock.origin],
      limits,
      signal: new AbortController().signal,
    }
    const objects = await detectMoonrakerObjects(detect)
    const detected = Object.freeze([
      ...objects,
      ...(await detectMoonrakerComponents(detect)),
    ])
    const attempt: Attempt = async (args) => {
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
        await fixed.driver.execute!('timelapse' as Action, args, {
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
    return await run(mock, attempt, detected)
  } finally {
    await mock.close()
  }
}

const withPlugin = {
  components: ['file_manager', 'history', 'timelapse'],
  timelapseFiles: [{ path: 'a.mp4' }, { path: 'b.mp4' }],
} satisfies MoonrakerMockOptions
const without = {
  components: ['file_manager', 'history', 'update_manager'],
  timelapseFiles: [{ path: 'a.mp4' }],
} satisfies MoonrakerMockOptions

const writes = (mock: Mock) =>
  mock.calls.all
    .map(({ method }) => method)
    .filter(
      (method) =>
        method === 'server.timelapse.render' ||
        method === 'server.files.delete_file',
    )
const remaining = async (origin: string) =>
  (
    (await (
      await fetch(`${origin}/server/files/list?root=timelapse`)
    ).json()) as {
      result: Array<{ path: string }>
    }
  ).result.map(({ path }) => path)

describe('timelapse on the E16 mock with the plugin', () => {
  it('detects the plugin from server.info and advertises the action', async () => {
    await withMock(withPlugin, async (_mock, _attempt, detected) => {
      expect(detected).toContain(TIMELAPSE_COMPONENT_MARKER)
      expect(moonrakerControls(detected)).toContain('timelapse')
    })
  })

  it('renders once, after one settings read', async () => {
    await withMock(withPlugin, async (mock, attempt) => {
      expect(await attempt({ op: 'render' })).toMatchObject({
        ok: true,
        guard: 1,
      })
      expect(writes(mock)).toEqual(['server.timelapse.render'])
      expect(
        mock.calls.all.filter(
          ({ method }) => method === 'server.timelapse.get_settings',
        ),
      ).toHaveLength(1)
    })
  })

  it('refuses a render while another one runs and sends nothing', async () => {
    await withMock(withPlugin, async (mock, attempt) => {
      await fetch(`${mock.origin}/server/timelapse/settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rendering: true }),
      })
      const result = await attempt({ op: 'render' })
      expect(result).toMatchObject({ ok: false, guard: 0 })
      expect((result.error as TimelapseRefused).refusal).toBe('state')
      expect(writes(mock)).toEqual([])
    })
  })

  it('deletes only the named video', async () => {
    await withMock(withPlugin, async (mock, attempt) => {
      expect(await remaining(mock.origin)).toEqual(['a.mp4', 'b.mp4'])
      expect(await attempt({ op: 'delete', file: 'a.mp4' })).toMatchObject({
        ok: true,
        guard: 1,
      })
      expect(writes(mock)).toEqual(['server.files.delete_file'])
      expect(await remaining(mock.origin)).toEqual(['b.mp4'])
    })
  })

  it('refuses to delete a video that is not listed', async () => {
    await withMock(withPlugin, async (mock, attempt) => {
      const result = await attempt({ op: 'delete', file: 'z.mp4' })
      expect(result).toMatchObject({ ok: false, guard: 0 })
      expect((result.error as TimelapseRefused).refusal).toBe('state')
      expect(writes(mock)).toEqual([])
      expect(await remaining(mock.origin)).toEqual(['a.mp4', 'b.mp4'])
    })
  })

  it.each([
    { op: 'delete', file: '../gcodes/a.gcode' },
    { op: 'delete', file: 'sub/a.mp4' },
    { op: 'render', file: 'a.mp4' },
    { op: 'bogus' },
  ])('refuses %j as invalid and sends nothing', async (args) => {
    await withMock(withPlugin, async (mock, attempt) => {
      const result = await attempt(args)
      expect(result).toMatchObject({ ok: false, guard: 0 })
      expect((result.error as TimelapseRefused).refusal).toBe('invalid-command')
      expect(writes(mock)).toEqual([])
    })
  })
})

describe('timelapse on the E16 mock without the plugin', () => {
  it('does not advertise it', async () => {
    await withMock(without, async (_mock, _attempt, detected) => {
      expect(detected).not.toContain(TIMELAPSE_COMPONENT_MARKER)
      expect(moonrakerControls(detected)).not.toContain('timelapse')
    })
  })

  it('refuses every op and sends no timelapse or delete request', async () => {
    await withMock(without, async (mock, attempt) => {
      for (const args of [{ op: 'render' }, { op: 'delete', file: 'a.mp4' }]) {
        const result = await attempt(args)
        expect(result).toMatchObject({ ok: false, guard: 0 })
        expect((result.error as TimelapseRefused).refusal).toBe(
          'unsupported-action',
        )
      }
      expect(writes(mock)).toEqual([])
      expect(
        mock.calls.all.filter(({ method }) =>
          method.startsWith('server.timelapse.'),
        ),
      ).toEqual([])
      expect(await remaining(mock.origin)).toEqual(['a.mp4'])
    })
  })
})

describe('TimelapsePanel', () => {
  const file = '../printer-detail/TimelapsePanel.vue'
  const base = {
    advertised: true,
    canCommand: true,
    canTransfer: true,
    files: ['timelapse_1.mp4', 'timelapse_2.mp4'],
  }

  it('lists videos with play, download and delete, plus render', async () => {
    const html = await renderFarmComponent(file, base)
    for (const text of [
      'Timelapse',
      'timelapse_1.mp4',
      'Renderizar timelapse',
      'Nenhuma renderização em andamento.',
      'aria-label="Reproduzir timelapse_1.mp4"',
      'aria-label="Baixar timelapse_2.mp4"',
      'aria-label="Excluir timelapse_2.mp4"',
    ])
      expect(html).toContain(text)
    expect(html).not.toContain('disabled')
  })

  it('says so when empty or without data', async () => {
    expect(await renderFarmComponent(file, { ...base, files: [] })).toContain(
      'Nenhum timelapse renderizado.',
    )
    const html = await renderFarmComponent(file, { ...base, files: undefined })
    expect(html).toContain('Sem dados de timelapse neste momento.')
    expect(html).not.toContain('<ul')
  })

  it('turns render off while one is running', async () => {
    const html = await renderFarmComponent(file, { ...base, rendering: true })
    expect(html).toContain('Renderização em andamento.')
    expect(html.match(/disabled/g)).toHaveLength(1)
  })

  it('keeps commands off, with the reason, when unavailable', async () => {
    const html = await renderFarmComponent(file, {
      ...base,
      canCommand: false,
      disabledReason: 'Comando indisponível. Não há conexão direta ao vivo.',
    })
    expect(html).toContain('Não há conexão direta ao vivo.')
    // Render and two deletes; play and download stay on.
    expect(html.match(/disabled/g)).toHaveLength(3)
  })

  it('keeps play and download off, with the reason, without a transfer channel', async () => {
    const html = await renderFarmComponent(file, {
      ...base,
      canTransfer: false,
      transferReason: 'Canal de transferência indisponível.',
    })
    expect(html).toContain('Canal de transferência indisponível.')
    expect(html.match(/disabled/g)).toHaveLength(4)
  })

  it('shows only the catalog reason when not advertised', async () => {
    const html = await renderFarmComponent(file, {
      ...base,
      advertised: false,
      disabledReason: 'Timelapse indisponível: o plugin não está instalado.',
    })
    expect(html).toContain('o plugin não está instalado.')
    expect(html).not.toContain('Renderizar timelapse')
    expect(html).not.toContain('timelapse_1.mp4')
  })
})

describe('command journal', () => {
  it('migrates a v8 journal and records timelapse', () => {
    // Scratch directory under the OS temp area; left in place on purpose.
    const directory = mkdtempSync(join(tmpdir(), 'timelapse-journal-'))
    closeCommandJournal(openCommandJournal({ directory, clock: Date.now }))
    const db = new DatabaseSync(join(directory, 'pause-commands.sqlite'))
    try {
      db.exec(
        "DROP TABLE control_command_actions; CREATE TABLE control_command_actions (cmd_id TEXT PRIMARY KEY, action TEXT NOT NULL CHECK(action IN ('pause','resume','cancel','emergency_stop','firmware_restart','run_macro','load_filament','unload_filament','extrude','set_led','set_pin','jog','motors_off','z_babystep','set_factor','queue_op','service','set_temperature','set_fan','home','set_light','set_speed','start_print'))) STRICT; INSERT INTO control_command_actions VALUES ('retained', 'queue_op'); PRAGMA user_version=8;",
      )
    } finally {
      db.close()
    }
    const journal = openCommandJournal({ directory, clock: Date.now })
    try {
      expect(readCommandAction(journal, 'retained')).toBe('queue_op')
    } finally {
      closeCommandJournal(journal)
    }
    const migrated = new DatabaseSync(join(directory, 'pause-commands.sqlite'))
    try {
      migrated
        .prepare('INSERT INTO control_command_actions VALUES (?,?)')
        .run('timelapse', 'timelapse')
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
