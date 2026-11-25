import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createMoonrakerSubscription } from '../../packages/connector/src/moonraker/subscription.ts'
import {
  declareSnapmakerU1Printers,
  mapSnapmakerU1Tools,
} from '../../packages/connector/src/moonraker/u1-tools.ts'
import { createPauseDriverRouter } from '../../packages/connector/src/runtime/pause-driver-router.ts'
import {
  startMoonrakerMock,
  type MoonrakerMockOptions,
} from '../../packages/sim-tools/src/mocks/moonraker-mock.ts'
import {
  createV2Authority,
  nodeSigner,
  openV2Dispatch,
} from '../helpers/command-v2-dispatch.ts'
import { moonrakerFixture } from '../helpers/moonraker-fixture.ts'

// Simulator only: no physical printer is contacted. The printers are seeded
// from the spec-derived (not captured) tests/fixtures/moonraker/u1 files.
// Wire format: Snapmaker/u1-klipper 93cb12faebf6e74c51bbc5f0be66e95124af14c8,
// klippy/kinematics/extruder.py registers T0-T3 (cmd_SWITCH_EXTRUDER_ADVANCED);
// `A0` selects that physical extruder without the print job's tool remap.
const TOOLS = [0, 1, 2, 3] as const
const objectName = (tool: number) => (tool ? `extruder${tool}` : 'extruder')
const limits = {
  maxMessageBytes: 65536,
  connectTimeoutMs: 2000,
  requestTimeoutMs: 2000,
  staleAfterMs: 2000,
  reconnectMinMs: 100,
  reconnectMaxMs: 100,
}

/** Mock options that reproduce a fixture's tools, temperatures and selection. */
function fromFixture(name: 'four-tools' | 'missing-fields') {
  const fixture = moonrakerFixture(`u1/${name}.jsonc`)
  const number = (value: unknown) => (typeof value === 'number' ? value : 0)
  const active: string = fixture.status.toolhead.extruder ?? 'extruder'
  const options: MoonrakerMockOptions = {
    // The fixtures list the tool objects only; control needs these too.
    objects: [
      ...fixture.objects,
      'print_stats',
      'virtual_sdcard',
      'gcode_move',
    ],
    initial: {
      activeExtruder: active,
      extruders: Object.fromEntries(
        TOOLS.map(objectName)
          .filter((object) => fixture.objects.includes(object))
          .map((object) => [
            object,
            {
              temperature: number(fixture.status[object]?.temperature),
              target: number(fixture.status[object]?.target),
            },
          ]),
      ),
    },
  }
  return { fixture, options }
}

async function world(t: TestContext, options: MoonrakerMockOptions) {
  const authority = await createV2Authority(await nodeSigner())
  const withdraw = declareSnapmakerU1Printers([
    { printerKey: authority.printerKey, model: 'Snapmaker U1' },
  ])
  t.after(withdraw)
  const remote = await startMoonrakerMock({ profile: 'u1', ...options })
  t.after(() => remote.close())
  let retired: Promise<void> | undefined
  const session = await openV2Dispatch(authority, {
    capability: { role: 'owner', actions: ['gcode'] },
    loopback: {
      origin: remote.origin,
      driver({ clock, observe }) {
        const router = createPauseDriverRouter({
          allowedOrigins: [remote.origin],
          limits,
          clock,
          observe,
          gcodeConsole: () => true,
        })
        return {
          ...router,
          closeAttempt(binding) {
            retired = router.closeAttempt(binding)
            return retired
          },
        }
      },
    },
  })
  t.after(() => session.close())
  async function run(line: string) {
    retired = undefined
    const result = await session.dispatch(
      await authority.sign(
        { action: 'gcode', args: { line }, purpose: 'printer-control' },
        session.now(),
      ),
    )
    await retired
    return result
  }
  async function tools() {
    const query = ['toolhead', ...TOOLS.map(objectName)].join('&')
    const response = await fetch(
      `${remote.origin}/printer/objects/query?${query}`,
    )
    const { result } = (await response.json()) as { result: { status: object } }
    return mapSnapmakerU1Tools(result.status)
  }
  return { remote, run, tools }
}

test('signed tool changes walk T0-T3 from the fixture state without touching heaters', async (t) => {
  const { fixture, options } = fromFixture('four-tools')
  const { remote, run, tools } = await world(t, options)
  const seeded = mapSnapmakerU1Tools(fixture.status, fixture.objects)
  const temperatures = (mapped: typeof seeded) =>
    mapped.tools.map((tool) => [tool.celsius, tool.targetCelsius])
  assert.equal((await tools()).activeTool, 'T2')

  // The live feed the browser reads must follow each change.
  const controller = new AbortController()
  const slots: string[] = []
  const subscription = createMoonrakerSubscription({
    assignment: {
      printerKey: 'u1',
      origin: remote.origin,
      model: 'Snapmaker U1',
    },
    allowedOrigins: [remote.origin],
    limits,
    discoverObjects: true,
    signal: controller.signal,
    onEvent() {},
    onRawObservation({ printer }) {
      const active = printer.materials?.find((material) => material.active)
      if (active) slots.push(active.slot)
    },
  })
  t.after(async () => {
    controller.abort()
    await subscription.done
  })
  async function observed(slot: string) {
    const deadline = performance.now() + 5000
    while (slots.at(-1) !== slot) {
      assert.ok(performance.now() < deadline, `Feed never showed ${slot}`)
      await delay(20)
    }
  }
  await observed('T2')

  // Every tool is both left and entered, including a repeat of the active one.
  const order = [0, 1, 3, 2, 0, 3, 3]
  for (const tool of order) {
    const result = await run(`T${tool}`)
    assert.equal(result.kind, 'applied', JSON.stringify({ tool, result }))
    const mapped = await tools()
    assert.deepEqual(
      mapped.tools.map((entry) => entry.active),
      TOOLS.map((index) => index === tool),
    )
    assert.deepEqual(temperatures(mapped), temperatures(seeded))
    await observed(`T${tool}`)
  }
  assert.deepEqual(
    remote.control.gcodeScripts,
    order.map((tool) => `T${tool} A0`),
  )
})

for (const state of ['printing', 'paused'] as const) {
  test(`every tool change is refused while ${state}`, async (t) => {
    const { options } = fromFixture('four-tools')
    const { remote, run, tools } = await world(t, options)
    remote.control.update({ state })
    for (const tool of TOOLS) {
      const result = await run(`T${tool}`)
      assert.equal(result.kind, 'not-sent', JSON.stringify({ tool, result }))
    }
    assert.deepEqual(remote.control.gcodeScripts, [])
    assert.equal((await tools()).activeTool, 'T2')
  })
}

test('every tool change is refused until X, Y and Z are homed', async (t) => {
  const { options } = fromFixture('four-tools')
  for (const homedAxes of ['', 'xy']) {
    const { remote, run } = await world(t, { ...options, homedAxes })
    for (const tool of TOOLS) {
      const result = await run(`T${tool}`)
      assert.equal(result.kind, 'not-sent', JSON.stringify({ tool, result }))
    }
    assert.deepEqual(remote.control.gcodeScripts, [])
  }
})

test('a tool the printer does not list is refused while the others change', async (t) => {
  const { fixture, options } = fromFixture('missing-fields')
  assert.ok(!fixture.objects.includes('extruder3'))
  const { remote, run } = await world(t, options)
  const absent = await run('T3')
  assert.equal(absent.kind, 'not-sent', JSON.stringify(absent))
  assert.deepEqual(remote.control.gcodeScripts, [])
  for (const tool of [0, 1, 2]) {
    const result = await run(`T${tool}`)
    assert.equal(result.kind, 'applied', JSON.stringify({ tool, result }))
    assert.equal(remote.control.model().activeExtruder, objectName(tool))
  }
  assert.deepEqual(remote.control.gcodeScripts, ['T0 A0', 'T1 A0', 'T2 A0'])
})

test('an acknowledged change the toolhead does not report stays unconfirmed', async (t) => {
  const { options } = fromFixture('four-tools')
  let revert = () => {}
  const { remote, run } = await world(t, {
    ...options,
    // Runs after the mock has applied and acknowledged the script.
    onMacroCall: () => queueMicrotask(() => revert()),
  })
  revert = () => remote.control.update({ activeExtruder: 'extruder2' })
  for (const tool of [0, 1, 3]) {
    const result = await run(`T${tool}`)
    assert.equal(result.kind, 'outcome-unknown', JSON.stringify(result))
    assert.equal(result.reason, 'state-unconfirmed')
  }
  // Each change was written once and never retried.
  assert.deepEqual(remote.control.gcodeScripts, ['T0 A0', 'T1 A0', 'T3 A0'])
  assert.equal(remote.calls()['printer.gcode.script'], 3)
})
