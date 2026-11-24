// SPDX-License-Identifier: MIT
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import {
  ControlArguments,
  ExtendedControlAction,
  GCODE_LINE_MAX_BYTES,
  GcodeLine,
  controlRoleAllowed,
  controlSourceState,
} from '../../packages/farm-protocol/src/control-actions.ts'
import { PrinterDetailStreamQueryResponse } from '../../packages/farm-protocol/src/printer-detail.ts'
import {
  closeCommandJournal,
  openCommandJournal,
  readCommandAction,
} from '../../packages/connector/src/control/command-journal.ts'
import { createPrinterBindingRegistry } from '../../packages/connector/src/control/printer-binding.ts'
import {
  CONSOLE_RATE_PER_MINUTE,
  ConsoleRefusal,
  buildConsoleScript,
  consoleAllowedWhenStopped,
  consoleAllowedWhilePrinting,
  parseConsoleState,
  parseGcodeHelp,
  refuseConsole,
  takeConsoleRate,
} from '../../packages/connector/src/moonraker/control-console.ts'
import { buildMoonrakerCommand } from '../../packages/connector/src/moonraker/commands.ts'
import {
  detectMoonrakerObjects,
  moonrakerControls,
} from '../../packages/connector/src/moonraker/control-support.ts'
import { createMoonrakerDetailStream } from '../../packages/connector/src/moonraker/detail-stream.ts'
import { openFixedMoonrakerPause } from '../../packages/connector/src/moonraker/pause-driver.ts'
import { actionsForControlRole } from '../../apps/farm/server/utils/pause-authority/role-policy.ts'
import { bambuControls } from '../../packages/connector/src/bambu/control-support.ts'
import { createPrinterDetailSession } from '../../packages/connector/src/runtime/printer-detail-session.ts'
import { createPauseDriverRouter } from '../../packages/connector/src/runtime/pause-driver-router.ts'
import {
  startMoonrakerMock,
  type MoonrakerMockInstance,
  type MoonrakerMockOptions,
} from '../../packages/sim-tools/src/mocks/moonraker-mock.ts'

const streamLimits = {
  maxMessageBytes: 1_048_576,
  connectTimeoutMs: 1500,
  requestTimeoutMs: 1500,
  staleAfterMs: 5000,
  reconnectMinMs: 40,
  reconnectMaxMs: 160,
}
const limits = {
  maxMessageBytes: 4096,
  connectTimeoutMs: 1500,
  requestTimeoutMs: 1500,
  staleAfterMs: 5000,
  reconnectMinMs: 40,
  reconnectMaxMs: 160,
}
let monotonic = 0
const clock = { monotonicNow: () => (monotonic += 0.001) }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until<T>(read: () => T | undefined | false, ms = 3000) {
  const end = Date.now() + ms
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() > end) throw new Error('Timed out')
    await sleep(10)
  }
}

describe('console arguments and policy', () => {
  it('is a signed action limited to administrators', () => {
    expect(ExtendedControlAction.options).toContain('gcode')
    expect(controlRoleAllowed('owner', 'gcode')).toBe(true)
    expect(controlRoleAllowed('admin', 'gcode')).toBe(true)
    expect(controlRoleAllowed('operator', 'gcode')).toBe(false)
    expect(controlRoleAllowed('viewer', 'gcode')).toBe(false)
    expect(controlSourceState('gcode', 'idle')).toBe(true)
    expect(controlSourceState('gcode', 'printing')).toBe(true)
    expect(controlSourceState('gcode', 'error')).toBe(false)
    expect(controlSourceState('gcode', 'unknown')).toBe(false)
  })

  it.each([
    'G28',
    'M220 S120',
    'M117 Olá'.replace('á', 'a'),
    'G'.repeat(GCODE_LINE_MAX_BYTES),
  ])('accepts %s', (line) => {
    expect(
      ControlArguments.safeParse({ action: 'gcode', args: { line } }).success,
    ).toBe(true)
  })

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['too long', 'G'.repeat(GCODE_LINE_MAX_BYTES + 1)],
    ['newline', 'G28\nM112'],
    ['carriage return', 'G28\rM112'],
    ['tab', 'G28\tX'],
    ['NUL', 'G28\x00'],
    ['DEL', 'G28\x7f'],
    ['non-ASCII', 'M117 olá'],
    ['emoji', 'M117 🙂'],
  ])('refuses %s', (_name, line) => {
    expect(GcodeLine.safeParse(line).success).toBe(false)
    expect(
      ControlArguments.safeParse({ action: 'gcode', args: { line } }).success,
    ).toBe(false)
    expect(() => buildConsoleScript({ line })).toThrow(ConsoleRefusal)
  })

  it('refuses extra and missing arguments', () => {
    for (const args of [{}, { line: 1 }, { line: 'G28', extra: 1 }])
      expect(
        ControlArguments.safeParse({ action: 'gcode', args }).success,
      ).toBe(false)
  })

  it('goes through the Moonraker command builder as one script', () => {
    expect(buildMoonrakerCommand('gcode', { line: ' G28 X ' })).toEqual({
      method: 'printer.gcode.script',
      params: { script: 'G28 X' },
    })
    expect(() => buildMoonrakerCommand('gcode', { line: 'G28;M112' })).toThrow()
    expect(() =>
      buildMoonrakerCommand('gcode', { line: 'G28', x: 1 }),
    ).toThrow()
  })
})

describe('allow-list while printing or paused', () => {
  it.each([
    'M220 S120',
    'm221 s95',
    'SET_GCODE_OFFSET Z_ADJUST=-0.02',
    'SET_FAN_SPEED FAN=aux SPEED=0.5',
    'SET_LED LED=case RED=1 GREEN=0 BLUE=0',
    'SET_PIN PIN=caselight VALUE=1',
    'M117 Hello',
    'GET_POSITION',
    'QUERY_ENDSTOPS',
    'QUERY_PROBE',
    'M105',
    'M114',
    'M115',
  ])('allows %s', (line) => {
    expect(consoleAllowedWhilePrinting(line)).toBe(true)
  })

  it.each([
    'G28',
    'G1 X10',
    'G91',
    'M104 S250',
    'M109 S250',
    'M140 S100',
    'M84',
    'M112',
    'G0 Z10',
    'SET_HEATER_TEMPERATURE HEATER=extruder TARGET=300',
    'SET_GCODE_OFFSET Z_ADJUST=0.02 MOVE=1',
    'SET_GCODE_OFFSET X_ADJUST=1',
    'SET_GCODE_OFFSET',
    'M220',
    'M220 S120 S130',
    'M105 X',
    'QUERY_ENDSTOPS;G28',
    'QUERY',
    'QUERY_',
    'M220S120',
    'M2200',
    'M105;G28',
    'N1 M105',
    'RESTART',
    'FIRMWARE_RESTART',
    'SET_PIN PIN=x VALUE=1 G28',
    'SET_PIN PIN=x VALUE="1"',
    'SAVE_CONFIG',
  ])('refuses %s', (line) => {
    expect(consoleAllowedWhilePrinting(line)).toBe(false)
  })

  it('accepts more while stopped, but never restarts or saves config', () => {
    for (const line of ['G28', 'G1 X10 F3000', 'M104 S0', 'BED_MESH_CALIBRATE'])
      expect(consoleAllowedWhenStopped(line)).toBe(true)
    for (const line of [
      'RESTART',
      'firmware_restart',
      'SAVE_CONFIG',
      'SDCARD_PRINT_FILE FILENAME=a.gcode',
      'G28;RESTART',
    ])
      expect(consoleAllowedWhenStopped(line)).toBe(false)
  })

  it('decides by the parsed print state', () => {
    const ready = (printState: string) =>
      parseConsoleState({
        eventtime: 1,
        status: {
          webhooks: { state: 'ready' },
          print_stats: { state: printState },
        },
      })
    const code = (line: string, printState: string) => {
      try {
        refuseConsole({ line }, ready(printState))
        return 'sent'
      } catch (error) {
        return (error as ConsoleRefusal).code
      }
    }
    expect(code('G28', 'standby')).toBe('sent')
    expect(code('G28', 'cancelled')).toBe('sent')
    expect(code('G28', 'printing')).toBe('not-allowed')
    expect(code('G28', 'paused')).toBe('not-allowed')
    expect(code('M220 S110', 'printing')).toBe('sent')
    expect(code('M220 S110', 'error')).toBe('unknown-state')
    expect(code('G28\nM112', 'standby')).toBe('invalid')
    expect(code('G28\n', 'standby')).toBe('invalid')
    expect(() => refuseConsole({ line: 'M105' }, undefined)).toThrow(
      ConsoleRefusal,
    )
    expect(() =>
      refuseConsole(
        { line: 'M105' },
        parseConsoleState({
          eventtime: 1,
          status: {
            webhooks: { state: 'startup' },
            print_stats: { state: 'standby' },
          },
        }),
      ),
    ).toThrow(ConsoleRefusal)
    expect(() => parseConsoleState({ eventtime: 1, status: {} })).toThrow(
      ConsoleRefusal,
    )
  })

  it('limits sends to ten a minute per printer and fails closed', () => {
    const one = {}
    const other = {}
    for (let i = 0; i < CONSOLE_RATE_PER_MINUTE; i++)
      takeConsoleRate(one, 1_000 + i)
    expect(() => takeConsoleRate(one, 5_000)).toThrow(ConsoleRefusal)
    takeConsoleRate(other, 5_000)
    takeConsoleRate(one, 61_100)
    expect(() => takeConsoleRate({}, Number.NaN)).toThrow(ConsoleRefusal)
  })
})

describe('autocomplete source', () => {
  it('keeps only command names from printer.gcode.help', () => {
    expect(
      parseGcodeHelp({ G28: 'Home', SET_LED: 'x', 'bad name': 'x', '': 'x' }),
    ).toEqual(['G28', 'SET_LED'])
    expect(parseGcodeHelp(null)).toEqual([])
    expect(parseGcodeHelp([1])).toEqual([])
    expect(
      PrinterDetailStreamQueryResponse.safeParse({
        v: 1,
        t: 'query.response',
        printerKey: 'printer-a',
        requestId: 'q1',
        kind: 'gcode-help',
        data: ['G28'],
      }).success,
    ).toBe(true)
  })
})

describe('Moonraker console on the E16 mock', () => {
  const closers: Array<() => Promise<void> | void> = []
  afterEach(async () => {
    for (const close of closers.splice(0)) await close()
  })

  async function withMock<T>(
    options: MoonrakerMockOptions,
    enabled: boolean,
    run: (
      mock: MoonrakerMockInstance,
      attempt: (
        action: ExtendedControlAction,
        args: Record<string, unknown>,
      ) => Promise<{ ok: boolean; error?: unknown; guard: number }>,
    ) => Promise<T>,
  ): Promise<T> {
    const mock = await startMoonrakerMock(options)
    closers.push(() => mock.close())
    const binding = createPrinterBindingRegistry({
      allowedOrigins: [mock.origin],
    }).provision({
      assignment_id: randomUUID(),
      farm_id: randomUUID(),
      agent_id: randomUUID(),
      printer_key: 'printer-console',
      moonraker_origin: mock.origin,
    })
    const objects = await detectMoonrakerObjects({
      binding,
      allowedOrigins: [mock.origin],
      limits,
      signal: new AbortController().signal,
    })
    const attempt = async (
      action: ExtendedControlAction,
      args: Record<string, unknown>,
    ) => {
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
        objects,
        gcodeConsole: enabled,
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
    return run(mock, attempt)
  }

  it('is disabled by default and writes nothing', async () => {
    await withMock({}, false, async (mock, attempt) => {
      const result = await attempt('gcode', { line: 'M105' })
      expect(result).toMatchObject({ ok: false, guard: 0 })
      expect((result.error as ConsoleRefusal).code).toBe('disabled')
      expect(mock.control.gcodeScripts).toEqual([])
    })
  })

  it('sends one line when enabled and stopped', async () => {
    await withMock({}, true, async (mock, attempt) => {
      expect(await attempt('gcode', { line: ' G28 ' })).toMatchObject({
        ok: true,
        guard: 1,
      })
      expect(mock.control.gcodeScripts).toEqual(['G28 X Y Z'])
    })
  })

  it.each(['printing', 'paused'] as const)(
    'accepts only the tuning allow-list while %s',
    async (state) => {
      await withMock({ initial: { state } }, true, async (mock, attempt) => {
        for (const line of ['G28', 'G1 X10', 'M104 S250', 'RESTART']) {
          const result = await attempt('gcode', { line })
          expect(result).toMatchObject({ ok: false, guard: 0 })
          expect((result.error as ConsoleRefusal).code).toBe('not-allowed')
          // The dispatcher turns this into a not-sent result, not "unknown".
          expect(result.error).toMatchObject({ refusal: 'invalid-command' })
        }
        expect(mock.control.gcodeScripts).toEqual([])
        expect((await attempt('gcode', { line: 'M220 S120' })).ok).toBe(true)
        expect(mock.control.gcodeScripts).toEqual(['M220 S120'])
        expect(mock.control.model().speedFactor).toBe(1.2)
      })
    },
  )

  it('refuses bad lines before any write', async () => {
    await withMock({}, true, async (mock, attempt) => {
      for (const line of [
        'G28\nM112',
        'G'.repeat(GCODE_LINE_MAX_BYTES + 1),
        'M117 olá',
        '',
      ]) {
        const result = await attempt('gcode', { line })
        expect(result).toMatchObject({ ok: false, guard: 0 })
        expect((result.error as ConsoleRefusal).code).toBe('invalid')
      }
      const extra = await attempt('gcode', { line: 'M105', extra: 1 })
      expect((extra.error as ConsoleRefusal).code).toBe('invalid')
      expect(mock.control.gcodeScripts).toEqual([])
    })
  })

  it('refuses without a G-code object list and in error state', async () => {
    await withMock(
      { initial: { state: 'error' } },
      true,
      async (mock, attempt) => {
        const result = await attempt('gcode', { line: 'M105' })
        expect((result.error as ConsoleRefusal).code).toBe('unknown-state')
        expect(result.error).toMatchObject({ refusal: 'state' })
        expect(mock.control.gcodeScripts).toEqual([])
      },
    )
  })

  it('stops at the console rate and never retries', async () => {
    await withMock({}, true, async (mock, attempt) => {
      for (let i = 0; i < CONSOLE_RATE_PER_MINUTE; i++)
        expect((await attempt('gcode', { line: 'M105' })).ok).toBe(true)
      const result = await attempt('gcode', { line: 'M105' })
      expect(result).toMatchObject({ ok: false, guard: 0 })
      expect((result.error as ConsoleRefusal).code).toBe('rate')
      expect(mock.control.gcodeScripts).toHaveLength(CONSOLE_RATE_PER_MINUTE)
    })
  })

  it('shows response lines through the detail stream', async () => {
    await withMock({}, true, async (mock, attempt) => {
      const stream = createMoonrakerDetailStream({
        printerKey: 'printer-console',
        origin: mock.origin,
        limits: streamLimits,
      })
      const frames: Array<{ t: string; lines?: string[] }> = []
      closers.push(stream.subscribe((frame) => frames.push(frame as never)))
      await until(() => frames.find((frame) => frame.t === 'detail.update'))
      expect((await attempt('gcode', { line: 'M118 hello console' })).ok).toBe(
        true,
      )
      const response = await until(() =>
        frames.find((frame) => frame.t === 'detail.gcode_response'),
      )
      expect(response.lines?.join('\n')).toContain('hello console')
    })
  })

  it('serves autocomplete from printer.gcode.help', async () => {
    const mock = await startMoonrakerMock({})
    closers.push(() => mock.close())
    const stream = createMoonrakerDetailStream({
      printerKey: 'printer-console',
      origin: mock.origin,
      limits: streamLimits,
    })
    const wires: string[] = []
    const session = createPrinterDetailSession(
      () => stream,
      () => true,
      (batch) => wires.push(...batch),
    )
    closers.push(() => session.close())
    const { encodePrinterDetailFrames } =
      await import('../../packages/farm-protocol/src/printer-detail.ts')
    const send = (frame: unknown) =>
      encodePrinterDetailFrames(frame, randomUUID()).forEach((wire) =>
        session.receive(wire),
      )
    const base = { v: 1, printerKey: 'printer-console' }
    send({ ...base, t: 'detail.subscribe' })
    await until(() => wires.find((wire) => wire.includes('detail.update')))
    send({ ...base, t: 'query.request', requestId: 'q1', kind: 'gcode-help' })
    const reply = await until(() =>
      wires.find((wire) => wire.includes('gcode-help')),
    )
    expect(reply).toContain('SET_LED')
    expect(reply).not.toContain('Set LED color')
  })

  it('advertises the console only when the local switch is on', async () => {
    const mock = await startMoonrakerMock({})
    closers.push(() => mock.close())
    const binding = createPrinterBindingRegistry({
      allowedOrigins: [mock.origin],
    }).provision({
      assignment_id: randomUUID(),
      farm_id: randomUUID(),
      agent_id: randomUUID(),
      printer_key: 'printer-console',
      moonraker_origin: mock.origin,
    })
    const make = (gcodeConsole?: (target: unknown) => boolean) =>
      createPauseDriverRouter({
        allowedOrigins: [mock.origin],
        limits,
        clock,
        observe: () => false,
        ...(gcodeConsole ? { gcodeConsole } : {}),
      })
    expect(await make().detect(binding)).not.toContain('gcode')
    expect(await make(() => false).detect(binding)).not.toContain('gcode')
    expect(await make(() => true).detect(binding)).toContain('gcode')
    expect(moonrakerControls(undefined)).not.toContain('gcode')
    expect(bambuControls('X1C')).not.toContain('gcode')
    expect(bambuControls('X1C', false)).not.toContain('gcode')
    expect(bambuControls('X1C', true)).toContain('gcode')
    expect(bambuControls(undefined, true)).not.toContain('gcode')
    expect(actionsForControlRole('owner', ['gcode'])).toEqual(['gcode'])
    expect(actionsForControlRole('admin', ['gcode'])).toEqual(['gcode'])
    expect(actionsForControlRole('operator', ['gcode'])).toEqual([])
    expect(actionsForControlRole('viewer', ['gcode'])).toEqual([])
  })
})

describe('command journal', () => {
  it.each([11, 14])(
    'migrates a v%s journal and records the gcode action',
    (version) => {
      // Scratch directory under the OS temp area; left in place on purpose.
      const directory = mkdtempSync(join(tmpdir(), 'console-journal-'))
      onTestFinished(() => rmSync(directory, { recursive: true, force: true }))
      closeCommandJournal(openCommandJournal({ directory, clock: Date.now }))
      const path = join(directory, 'pause-commands.sqlite')
      const db = new DatabaseSync(path)
      try {
        const sql = (
          db
            .prepare(
              "SELECT sql FROM sqlite_schema WHERE name='control_command_actions'",
            )
            .get() as { sql: string }
        ).sql
        expect(sql).toContain("'set_pin','gcode'")
        const v14 = sql
          .replace(",'set_tool_temperature'", '')
          .replace(",'start_library_print'", '')
          .replace(",'config_write'", '')
        const historical =
          version === 14
            ? v14
            : v14.replace(",'gcode'", '').replace(",'file_op'", '')
        db.exec(
          `DROP INDEX pause_active_assignment; DROP INDEX pause_active_printer; CREATE UNIQUE INDEX pause_active_assignment ON pause_commands(assignment_id) WHERE status IN ('claimed','write-started','outcome-unknown'); CREATE UNIQUE INDEX pause_active_printer ON pause_commands(farm_id,printer_key) WHERE status IN ('claimed','write-started','outcome-unknown'); DROP TABLE control_tool_temperature_args; DROP TABLE control_command_actions; ${historical}; INSERT INTO control_command_actions VALUES ('retained', 'set_pin'); PRAGMA user_version=${version};`,
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
      const migrated = new DatabaseSync(path)
      try {
        migrated
          .prepare('INSERT INTO control_command_actions VALUES (?,?)')
          .run('console', 'gcode')
        expect(() =>
          migrated.exec(
            "INSERT INTO control_command_actions VALUES ('invalid', 'invalid')",
          ),
        ).toThrow()
      } finally {
        migrated.close()
      }
    },
  )
})
