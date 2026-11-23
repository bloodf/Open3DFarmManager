import { afterEach, expect, test } from 'vitest'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runConnectorAgent } from '../../packages/connector/src/runtime/agent.ts'
import {
  agentSetup,
  moonrakerSimulator,
  spoolmanSimulator,
  waitFor,
} from './connector-wiring-sims.ts'

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

/**
 * Starts the real agent composition against a Moonraker and a Spoolman
 * simulator, lets the printer finish one watched job and returns once the
 * run is journaled.
 */
async function runOneJob(input: {
  spoolId: number | null | 'absent'
  assignments: { slot: string; spoolId: number }[]
  lose?: boolean
  model?: string
  status?: Record<string, unknown>
  millimetres: number
}) {
  const moonraker = await moonrakerSimulator({
    spoolId: input.spoolId,
    ...(input.status ? { status: input.status } : {}),
  })
  cleanup.push(moonraker.stop)
  const spoolman = await spoolmanSimulator({ lose: input.lose === true })
  cleanup.push(spoolman.stop)
  const setup = agentSetup({
    collection: ({ farm }) => ({
      version: 1,
      allowedOrigins: [moonraker.origin],
      printers: [
        {
          printerKey: 'printer',
          origin: moonraker.origin,
          ...(input.model ? { model: input.model } : {}),
        },
      ],
      spoolman: {
        origin: spoolman.origin,
        farmId: farm,
        serviceId: randomUUID(),
      },
    }),
    assignmentExtra: { moonraker_origin: moonraker.origin },
  })
  cleanup.push(setup.remove)
  writeFileSync(
    join(setup.directory, 'active-spool-assignments.json'),
    JSON.stringify({
      version: 1,
      assignments: input.assignments.map((row) => ({
        printerKey: 'printer',
        ...row,
      })),
    }),
  )
  const controller = new AbortController()
  const diagnostics: { kind: string; status?: string; reason?: unknown }[] = []
  let failure: unknown
  const running = runConnectorAgent({
    configPath: setup.configPath,
    credentialPath: setup.credentialPath,
    dataDirectory: setup.directory,
    signal: controller.signal,
    onDiagnostic: (value) => diagnostics.push(value as never),
  }).catch((error: unknown) => {
    failure = error
  })
  cleanup.push(async () => {
    controller.abort()
    await running
  })
  await waitFor(() => {
    if (failure) throw failure
    return moonraker.connected()
  }, 'Moonraker subscription')
  // Let the agent observe the printing state (and read the starting spools).
  await new Promise((resolve) => setTimeout(resolve, 300))
  moonraker.finish(input.millimetres)
  await waitFor(() => {
    if (failure) throw failure
    return diagnostics.some((value) => value.kind === 'filament-run')
  }, 'filament run outcome')
  return { moonraker, spoolman, setup, diagnostics }
}

test('a completed run with an assigned spool is debited once in Spoolman', async () => {
  const { moonraker, spoolman, setup } = await runOneJob({
    spoolId: 'absent',
    assignments: [{ slot: 'T0', spoolId: 7 }],
    millimetres: 123,
  })
  expect(spoolman.uses).toEqual([{ spoolId: 7, body: { use_length: 123 } }])
  expect(setup.journal()).toMatchObject([
    { status: 'applied', spoolId: 7, tool: 'T0' },
  ])
  // Repeated terminal observations never debit the run again.
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(spoolman.uses).toHaveLength(1)
  // Accounting reads only: no printer command was sent.
  expect(
    moonraker.methods.every((method) =>
      [
        'server.connection.identify',
        'printer.objects.list',
        'printer.objects.subscribe',
        'printer.objects.query',
      ].includes(method),
    ),
  ).toBe(true)
})

test('a printer whose Moonraker reports to Spoolman is recorded, not debited', async () => {
  const { spoolman, setup } = await runOneJob({
    spoolId: 42,
    assignments: [{ slot: 'T0', spoolId: 7 }],
    millimetres: 80,
  })
  expect(spoolman.uses).toEqual([])
  expect(setup.journal()).toMatchObject([
    { status: 'record-only', reason: 'moonraker-reports', spoolId: 42 },
  ])
})

test('a lost debit response is journaled uncertain and never retried', async () => {
  const { spoolman, setup, diagnostics } = await runOneJob({
    spoolId: 'absent',
    assignments: [{ slot: 'T0', spoolId: 7 }],
    lose: true,
    millimetres: 50,
  })
  expect(setup.journal()).toMatchObject([
    { status: 'uncertain', reason: 'response-lost', spoolId: 7 },
  ])
  expect(diagnostics).toContainEqual({
    kind: 'filament-run',
    status: 'uncertain',
    reason: 'response-lost',
  })
  await new Promise((resolve) => setTimeout(resolve, 1000))
  expect(spoolman.uses).toHaveLength(1)
})

test('a declared Snapmaker U1 attributes the run to its active tool', async () => {
  const { moonraker, spoolman, setup } = await runOneJob({
    spoolId: 'absent',
    model: 'Snapmaker U1',
    status: {
      toolhead: { extruder: 'extruder1' },
      extruder: { temperature: 25, target: 0 },
      extruder1: { temperature: 220, target: 220 },
      extruder2: { temperature: 25, target: 0 },
      extruder3: { temperature: 25, target: 0 },
    },
    assignments: [
      { slot: 'T0', spoolId: 7 },
      { slot: 'T1', spoolId: 9 },
    ],
    millimetres: 55,
  })
  // The U1 subscription asks for every tool and the active tool.
  expect(moonraker.subscribed[0]).toMatchObject({
    extruder1: ['temperature', 'target'],
    extruder3: ['temperature', 'target'],
    toolhead: ['extruder'],
  })
  expect(spoolman.uses).toEqual([{ spoolId: 9, body: { use_length: 55 } }])
  expect(setup.journal()).toMatchObject([
    { status: 'applied', spoolId: 9, tool: 'T1' },
  ])
})

test('a generic Moonraker printer does not get the U1 tool subscription', async () => {
  const { moonraker } = await runOneJob({
    spoolId: 'absent',
    assignments: [{ slot: 'T0', spoolId: 7 }],
    millimetres: 5,
  })
  expect(moonraker.subscribed[0]).not.toHaveProperty('extruder1')
  expect(moonraker.subscribed[0]).not.toHaveProperty('toolhead')
})
