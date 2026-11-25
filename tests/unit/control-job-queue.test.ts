// SPDX-License-Identifier: MIT
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  ControlArguments,
  ExtendedControlAction,
  QueueOpArguments,
  controlRoleAllowed,
  controlSourceState,
  type ExtendedControlAction as Action,
} from '../../packages/farm-protocol/src/control-actions.ts'
import {
  closeCommandJournal,
  openCommandJournal,
  readCommandAction,
} from '../../packages/connector/src/control/command-journal.ts'
import { createPrinterBindingRegistry } from '../../packages/connector/src/control/printer-binding.ts'
import {
  JOB_QUEUE_COMPONENT_MARKER,
  JOB_QUEUE_MAX_JOBS,
  QueueRefused,
  parseQueueOp,
  parseQueueStatus,
  queueMarkers,
  queueSupported,
  refuseQueueOp,
} from '../../packages/connector/src/moonraker/control-job-queue.ts'
import { buildMoonrakerCommand } from '../../packages/connector/src/moonraker/commands.ts'
import {
  detectMoonrakerComponents,
  detectMoonrakerObjects,
  moonrakerControls,
} from '../../packages/connector/src/moonraker/control-support.ts'
import { openFixedMoonrakerPause } from '../../packages/connector/src/moonraker/pause-driver.ts'
import { renderFarmComponent } from '../helpers/render-farm-component.ts'
import { actionsForControlRole } from '../../apps/farm/server/utils/pause-authority/role-policy.ts'
import { startMoonrakerMock } from '../../packages/sim-tools/src/mocks/moonraker-mock.ts'
import type { MoonrakerMockOptions } from '../../packages/sim-tools/src/mocks/moonraker-mock.ts'

const MARKED = ['toolhead', JOB_QUEUE_COMPONENT_MARKER]

describe('queue_op arguments', () => {
  it.each([
    { op: 'add', files: ['cube.gcode'] },
    { op: 'add', files: ['pecas/cube.gcode', 'b.gcode'] },
    { op: 'remove', job_ids: ['0000000001', 'abc_DEF-2'] },
    { op: 'jump', job_ids: ['0000000001'] },
    { op: 'start' },
    { op: 'pause' },
  ])('accepts %j', (args) => {
    expect(
      ControlArguments.safeParse({ action: 'queue_op', args }).success,
    ).toBe(true)
  })
  it.each([
    {},
    { op: 'reset' },
    { op: 'add' },
    { op: 'add', files: [] },
    { op: 'add', files: ['a.gcode', 'a.gcode'] },
    { op: 'add', files: ['../etc/passwd'] },
    { op: 'add', files: ['/abs.gcode'] },
    { op: 'add', files: ['a\\b.gcode'] },
    { op: 'add', files: ['a/./b.gcode'] },
    { op: 'add', files: ['a//b.gcode'] },
    { op: 'add', files: ['bad\nname.gcode'] },
    { op: 'add', files: [''] },
    { op: 'add', files: ['x'.repeat(256)] },
    { op: 'add', files: Array.from({ length: 33 }, (_, i) => `f${i}.gcode`) },
    { op: 'add', files: ['a.gcode'], job_ids: ['1'] },
    { op: 'remove' },
    { op: 'remove', job_ids: [] },
    { op: 'remove', job_ids: ['1', '1'] },
    { op: 'remove', job_ids: ['a b'] },
    { op: 'remove', files: ['a.gcode'] },
    { op: 'jump' },
    { op: 'jump', job_ids: ['1', '2'] },
    { op: 'start', job_ids: ['1'] },
    { op: 'pause', files: ['a.gcode'] },
    { op: 'start', extra: 1 },
  ])('rejects %j', (args) => {
    expect(
      ControlArguments.safeParse({ action: 'queue_op', args }).success,
    ).toBe(false)
    expect(QueueOpArguments.safeParse(args).success).toBe(false)
  })
})

describe('queue_op policy', () => {
  it('is a signed action that operators and above may send', () => {
    expect(ExtendedControlAction.options).toContain('queue_op')
    for (const role of ['operator', 'admin', 'owner'])
      expect(controlRoleAllowed(role, 'queue_op')).toBe(true)
    expect(controlRoleAllowed('viewer', 'queue_op')).toBe(false)
    expect(controlRoleAllowed('', 'queue_op')).toBe(false)
  })
  it('runs in a known printer state and stays out of the v1 projection', () => {
    for (const state of ['idle', 'printing', 'paused', 'cancelled'])
      expect(controlSourceState('queue_op', state)).toBe(true)
    for (const state of ['unknown', 'error'])
      expect(controlSourceState('queue_op', state)).toBe(false)
    expect(actionsForControlRole('operator')).not.toContain('queue_op')
  })
})

describe('queue_op adapter', () => {
  it('maps each op to one Moonraker call from validated names only', () => {
    expect(
      parseQueueOp({ op: 'add', files: ['a.gcode', 'b/c.gcode'] }).call,
    ).toEqual({
      method: 'server.job_queue.post_job',
      params: { filenames: ['a.gcode', 'b/c.gcode'] },
    })
    expect(parseQueueOp({ op: 'remove', job_ids: ['7', '8'] }).call).toEqual({
      method: 'server.job_queue.delete_job',
      params: { job_ids: ['7', '8'] },
    })
    expect(parseQueueOp({ op: 'jump', job_ids: ['7'] }).call).toEqual({
      method: 'server.job_queue.jump',
      params: { job_id: '7' },
    })
    expect(parseQueueOp({ op: 'start' }).call).toEqual({
      method: 'server.job_queue.start',
    })
    expect(parseQueueOp({ op: 'pause' }).call).toEqual({
      method: 'server.job_queue.pause',
    })
  })
  it('goes through the command builder and needs the component', () => {
    expect(buildMoonrakerCommand('queue_op', { op: 'start' }, MARKED)).toEqual({
      method: 'server.job_queue.start',
    })
    expect(() =>
      buildMoonrakerCommand('queue_op', { op: 'start' }, ['toolhead']),
    ).toThrow(/Queue unavailable/)
    expect(() =>
      buildMoonrakerCommand('queue_op', { op: 'add', files: ['../x'] }, MARKED),
    ).toThrow(/invalid-command/)
  })
  it('never forwards a reset or an all flag', () => {
    expect(() =>
      parseQueueOp({ op: 'remove', job_ids: ['1'], all: true }),
    ).toThrow(QueueRefused)
    expect(() =>
      parseQueueOp({ op: 'add', files: ['a.gcode'], reset: true }),
    ).toThrow(QueueRefused)
  })
  it('refuses from the live queue and never guesses', () => {
    const status = parseQueueStatus({
      queue_state: 'ready',
      queued_jobs: [{ job_id: '1', filename: 'a.gcode' }],
    })
    const refusal = (op: unknown, current = status) => {
      try {
        refuseQueueOp(QueueOpArguments.parse(op), current)
      } catch (error) {
        return (error as QueueRefused).refusal
      }
      return undefined
    }
    expect(refusal({ op: 'remove', job_ids: ['1'] })).toBeUndefined()
    expect(refusal({ op: 'remove', job_ids: ['1', '2'] })).toBe('state')
    expect(refusal({ op: 'jump', job_ids: ['2'] })).toBe('state')
    expect(refusal({ op: 'start' })).toBeUndefined()
    expect(
      refusal(
        { op: 'start' },
        parseQueueStatus({ queue_state: 'paused', queued_jobs: [] }),
      ),
    ).toBe('state')
    expect(refusal({ op: 'pause' })).toBeUndefined()
    expect(refusal({ op: 'add', files: ['a.gcode'] })).toBeUndefined()
    const full = parseQueueStatus({
      queue_state: 'ready',
      queued_jobs: Array.from({ length: JOB_QUEUE_MAX_JOBS }, (_, i) => ({
        job_id: String(i),
      })),
    })
    expect(refusal({ op: 'add', files: ['a.gcode'] }, full)).toBe('state')
    expect(() =>
      refuseQueueOp(QueueOpArguments.parse({ op: 'start' }), undefined),
    ).toThrow(QueueRefused)
  })
  it('treats a malformed status as unknown state', () => {
    for (const bad of [
      undefined,
      {},
      { queue_state: 'ready' },
      { queue_state: 'ready', queued_jobs: 'x' },
      { queue_state: 'ready', queued_jobs: [{ filename: 'a' }] },
    ])
      expect(() => parseQueueStatus(bad)).toThrow(QueueRefused)
  })
  it('marks the component only from a well-formed server.info', () => {
    expect(queueMarkers({ components: ['history', 'job_queue'] })).toEqual([
      JOB_QUEUE_COMPONENT_MARKER,
    ])
    expect(queueMarkers({ components: ['history'] })).toEqual([])
    expect(queueMarkers({ components: 'job_queue' })).toEqual([])
    expect(queueMarkers(undefined)).toEqual([])
    expect(queueSupported(MARKED)).toBe(true)
    expect(queueSupported(['toolhead'])).toBe(false)
    expect(queueSupported(undefined)).toBe(false)
  })
  it('advertises queue_op only with the marker', () => {
    expect(moonrakerControls(MARKED)).toContain('queue_op')
    expect(moonrakerControls(['toolhead'])).not.toContain('queue_op')
    expect(moonrakerControls(undefined)).not.toContain('queue_op')
    expect(moonrakerControls([])).not.toContain('queue_op')
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
  // The E16 mock queues only files it stores, as Moonraker does.
  const mock = await startMoonrakerMock({
    files: [
      'cube.gcode',
      'pecas/gear.gcode',
      'a.gcode',
      'b.gcode',
      'c.gcode',
    ].map((path) => ({ path })),
    ...options,
  })
  try {
    const binding = createPrinterBindingRegistry({
      allowedOrigins: [mock.origin],
    }).provision({
      assignment_id: randomUUID(),
      farm_id: randomUUID(),
      agent_id: randomUUID(),
      printer_key: 'printer-queue',
      moonraker_origin: mock.origin,
    })
    const detect = {
      binding,
      allowedOrigins: [mock.origin],
      limits,
      signal: new AbortController().signal,
    }
    // The same two reads the router performs, in the same order.
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
        await fixed.driver.execute!('queue_op' as Action, args, {
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

const writes = (mock: Mock) =>
  mock.calls.all
    .map(({ method }) => method)
    .filter(
      (method) =>
        method.startsWith('server.job_queue.') &&
        method !== 'server.job_queue.status',
    )
async function queued(origin: string) {
  const reply = (await (
    await fetch(`${origin}/server/job_queue/status`)
  ).json()) as {
    result: {
      queue_state: string
      queued_jobs: Array<{ job_id: string; filename: string }>
    }
  }
  return reply.result
}

describe('queue_op on the E16 mock', () => {
  it('detects the job queue component from server.info', async () => {
    await withMock({}, async (_mock, _attempt, detected) => {
      expect(detected).toContain(JOB_QUEUE_COMPONENT_MARKER)
      expect(moonrakerControls(detected)).toContain('queue_op')
    })
  })

  it('adds files in one request', async () => {
    await withMock({}, async (mock, attempt) => {
      const result = await attempt({
        op: 'add',
        files: ['cube.gcode', 'pecas/gear.gcode'],
      })
      expect(result).toMatchObject({ ok: true, guard: 1 })
      expect(writes(mock)).toEqual(['server.job_queue.post_job'])
      expect(
        (await queued(mock.origin)).queued_jobs.map(({ filename }) => filename),
      ).toEqual(['cube.gcode', 'pecas/gear.gcode'])
    })
  })

  it('removes a listed job and leaves the others', async () => {
    await withMock({}, async (mock, attempt) => {
      await attempt({ op: 'add', files: ['a.gcode', 'b.gcode', 'c.gcode'] })
      const [first, second] = (await queued(mock.origin)).queued_jobs
      const result = await attempt({ op: 'remove', job_ids: [first!.job_id] })
      expect(result).toMatchObject({ ok: true, guard: 1 })
      expect(
        (await queued(mock.origin)).queued_jobs.map(({ job_id }) => job_id),
      ).not.toContain(first!.job_id)
      expect((await queued(mock.origin)).queued_jobs).toHaveLength(2)
      expect(
        (await queued(mock.origin)).queued_jobs.map(({ job_id }) => job_id),
      ).toContain(second!.job_id)
    })
  })

  it('jumps a listed job to the front', async () => {
    await withMock({}, async (mock, attempt) => {
      await attempt({ op: 'add', files: ['a.gcode', 'b.gcode', 'c.gcode'] })
      const last = (await queued(mock.origin)).queued_jobs[2]!
      const result = await attempt({ op: 'jump', job_ids: [last.job_id] })
      expect(result).toMatchObject({ ok: true, guard: 1 })
      expect(
        (await queued(mock.origin)).queued_jobs.map(({ filename }) => filename),
      ).toEqual(['c.gcode', 'a.gcode', 'b.gcode'])
    })
  })

  it('pauses without reading the queue and then starts it', async () => {
    await withMock({}, async (mock, attempt) => {
      const paused = await attempt({ op: 'pause' })
      expect(paused).toMatchObject({ ok: true, guard: 1 })
      expect(mock.calls.all.map(({ method }) => method)).not.toContain(
        'server.job_queue.status',
      )
      expect((await queued(mock.origin)).queue_state).toBe('paused')
      // Starting an empty queue is refused; with a job it resumes.
      expect(await attempt({ op: 'start' })).toMatchObject({
        ok: false,
        guard: 0,
      })
      await attempt({ op: 'add', files: ['a.gcode'] })
      expect(await attempt({ op: 'start' })).toMatchObject({
        ok: true,
        guard: 1,
      })
      // The E16 mock starts the queued job, as Moonraker does.
      expect((await queued(mock.origin)).queue_state).toBe('loading')
      expect(writes(mock)).toEqual([
        'server.job_queue.pause',
        'server.job_queue.post_job',
        'server.job_queue.start',
      ])
    })
  })

  it('refuses an unknown job before any write', async () => {
    await withMock({}, async (mock, attempt) => {
      await attempt({ op: 'add', files: ['a.gcode'] })
      const before = writes(mock).length
      for (const args of [
        { op: 'remove', job_ids: ['missing'] },
        { op: 'jump', job_ids: ['missing'] },
      ]) {
        const result = await attempt(args)
        expect(result).toMatchObject({ ok: false, guard: 0 })
        expect((result.error as QueueRefused).refusal).toBe('state')
      }
      expect(writes(mock)).toHaveLength(before)
      expect((await queued(mock.origin)).queued_jobs).toHaveLength(1)
    })
  })

  it('refuses malformed arguments before any read or write', async () => {
    await withMock({}, async (mock, attempt) => {
      const result = await attempt({ op: 'add', files: ['../outside.gcode'] })
      expect(result).toMatchObject({ ok: false, guard: 0 })
      expect((result.error as QueueRefused).refusal).toBe('invalid-command')
      expect(writes(mock)).toEqual([])
      expect(mock.calls.all.map(({ method }) => method)).not.toContain(
        'server.job_queue.status',
      )
    })
  })
})

describe('queue_op without the queue component', () => {
  const noQueue = {
    components: ['file_manager', 'history', 'update_manager'],
  } satisfies MoonrakerMockOptions

  it('does not advertise it', async () => {
    await withMock(noQueue, async (_mock, _attempt, detected) => {
      expect(detected).not.toContain(JOB_QUEUE_COMPONENT_MARKER)
      expect(moonrakerControls(detected)).not.toContain('queue_op')
    })
  })

  it('refuses every op and sends no queue request', async () => {
    await withMock(noQueue, async (mock, attempt) => {
      for (const args of [
        { op: 'add', files: ['a.gcode'] },
        { op: 'remove', job_ids: ['1'] },
        { op: 'jump', job_ids: ['1'] },
        { op: 'start' },
        { op: 'pause' },
      ]) {
        const result = await attempt(args)
        expect(result).toMatchObject({ ok: false, guard: 0 })
        expect((result.error as QueueRefused).refusal).toBe(
          'unsupported-action',
        )
      }
      expect(
        mock.calls.all.filter(({ method }) =>
          method.startsWith('server.job_queue.'),
        ),
      ).toEqual([])
    })
  })
})

describe('JobQueuePanel', () => {
  const file = '../printer-detail/JobQueuePanel.vue'
  const base = {
    advertised: true,
    canCommand: true,
    state: 'ready',
    jobs: [
      { id: '1', file: 'cubo.gcode' },
      { id: '2', file: 'pecas/engrenagem.gcode' },
    ],
  }

  it('lists the queue with one control per job and the queue actions', async () => {
    const html = await renderFarmComponent(file, base)
    for (const text of [
      'Fila de impressão',
      'Estado da fila: Pronta.',
      'cubo.gcode',
      'pecas/engrenagem.gcode',
      'Iniciar fila',
      'Pausar fila',
      'aria-label="Priorizar cubo.gcode"',
      'aria-label="Remover pecas/engrenagem.gcode da fila"',
      'Arquivos a adicionar',
      'Adicionar à fila',
    ])
      expect(html).toContain(text)
    expect(html).not.toContain('disabled')
  })

  it('says so when the queue is empty or no data arrived', async () => {
    expect(await renderFarmComponent(file, { ...base, jobs: [] })).toContain(
      'A fila está vazia.',
    )
    const html = await renderFarmComponent(file, {
      ...base,
      state: undefined,
      jobs: undefined,
    })
    expect(html).toContain('Sem dados da fila neste momento.')
    expect(html).not.toContain('<ol')
  })

  it('labels the queue states in Portuguese', async () => {
    for (const [state, label] of [
      ['paused', 'Pausada'],
      ['loading', 'Carregando'],
      ['starting', 'Iniciando'],
      ['weird', 'Desconhecido'],
    ] as const)
      expect(await renderFarmComponent(file, { ...base, state })).toContain(
        `Estado da fila: ${label}.`,
      )
  })

  it('stays visible but off, with the reason, when commands are unavailable', async () => {
    const html = await renderFarmComponent(file, {
      ...base,
      canCommand: false,
      disabledReason: 'Comando indisponível. Não há conexão direta ao vivo.',
    })
    expect(html).toContain('Não há conexão direta ao vivo.')
    // Two queue actions, two per job, the file field and the add button.
    expect(html.match(/disabled/g)?.length).toBeGreaterThanOrEqual(8)
  })

  it('shows only the catalog reason when the printer does not advertise it', async () => {
    const html = await renderFarmComponent(file, {
      ...base,
      advertised: false,
      disabledReason: 'Fila indisponível: o Moonraker não carrega a fila.',
    })
    expect(html).toContain('o Moonraker não carrega a fila.')
    expect(html).not.toContain('<form')
    expect(html).not.toContain('Iniciar fila')
  })
})

describe('command journal', () => {
  it('migrates a v6 journal and records queue_op', () => {
    // Scratch directory under the OS temp area; left in place on purpose.
    const directory = mkdtempSync(join(tmpdir(), 'queue-journal-'))
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }))
    closeCommandJournal(openCommandJournal({ directory, clock: Date.now }))
    const db = new DatabaseSync(join(directory, 'pause-commands.sqlite'))
    try {
      db.exec(
        "DROP INDEX pause_active_assignment; DROP INDEX pause_active_printer; CREATE UNIQUE INDEX pause_active_assignment ON pause_commands(assignment_id) WHERE status IN ('claimed','write-started','outcome-unknown'); CREATE UNIQUE INDEX pause_active_printer ON pause_commands(farm_id,printer_key) WHERE status IN ('claimed','write-started','outcome-unknown'); DROP TABLE control_tool_temperature_args; DROP TABLE control_command_actions; CREATE TABLE control_command_actions (cmd_id TEXT PRIMARY KEY, action TEXT NOT NULL CHECK(action IN ('pause','resume','cancel','emergency_stop','firmware_restart','run_macro','load_filament','unload_filament','extrude','set_led','set_pin','jog','motors_off','z_babystep','set_factor','set_temperature','set_fan','home','set_light','set_speed','start_print'))) STRICT; INSERT INTO control_command_actions VALUES ('retained', 'jog'); PRAGMA user_version=6;",
      )
    } finally {
      db.close()
    }
    const journal = openCommandJournal({ directory, clock: Date.now })
    try {
      expect(readCommandAction(journal, 'retained')).toBe('jog')
    } finally {
      closeCommandJournal(journal)
    }
    const migrated = new DatabaseSync(join(directory, 'pause-commands.sqlite'))
    try {
      migrated
        .prepare('INSERT INTO control_command_actions VALUES (?,?)')
        .run('queue', 'queue_op')
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
