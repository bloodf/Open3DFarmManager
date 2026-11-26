// HALOT token, session, status mapping and local configuration against the
// loopback simulator only. Wire facts: docs/protocols/halot.md.
import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import {
  Binding,
  readHalotPassword,
} from '../../packages/connector/src/halot/config.ts'
import { createHalotCollection } from '../../packages/connector/src/halot/collection.ts'
import { HALOT_MODEL_NAMES } from '../../packages/connector/src/halot/models.ts'
import {
  HalotTokenError,
  openHalotSession,
  type HalotStatusReply,
} from '../../packages/connector/src/halot/session.ts'
import { halotStatus } from '../../packages/connector/src/halot/status.ts'
import { halotTokens } from '../../packages/connector/src/halot/token.ts'
import { PrinterState } from '../../packages/farm-protocol/src/state.ts'
import {
  HALOT_SIMULATOR_PASSWORD,
  HALOT_SIMULATOR_TOKEN,
  startHalotSimulator,
} from '../../packages/sim-tools/src/halot-simulator.ts'

// ResinDeck core/tests/test_halot.cpp @ a00595a (MIT): password, the form with
// the appended block, and the 8-byte form.
const VECTORS = [
  ['a', 'yDsTd3KDH50=', 'yDsTd3KDH50='],
  ['abc', 'E/8A0f6OHM4=', 'E/8A0f6OHM4='],
  ['abcd', 'u51y6dxGPJ0=', 'u51y6dxGPJ0='],
  ['abcde', '0dvqm0ZkM9ysR7ACiBVuXA==', '0dvqm0ZkM9w='],
  ['secret1', 'Qxbcqf3F4aisR7ACiBVuXA==', 'Qxbcqf3F4ag='],
  ['12345678', 'uUR3lPKfxcGsR7ACiBVuXA==', 'uUR3lPKfxcE='],
  ['Ab3$%^&*', 'gDXhRCQHnIysR7ACiBVuXA==', 'gDXhRCQHnIw='],
] as const

test('tokens match the published values, the printer form first', () => {
  for (const [password, appended, short] of VECTORS) {
    // The printer encrypts every padded block: 8 characters make two.
    const expected =
      password.length <= 4
        ? [short]
        : password.length < 8
          ? [short, appended]
          : [appended, short]
    assert.deepEqual(halotTokens(password), expected, password)
  }
  for (const password of ['', '123456789', 'senhá'])
    assert.throws(() => halotTokens(password), /Invalid HALOT password/)
})

async function simulator(
  t: TestContext,
  options?: Parameters<typeof startHalotSimulator>[0],
) {
  const sim = await startHalotSimulator(options)
  t.after(sim.close)
  return sim
}

const open = (port: number, password = HALOT_SIMULATOR_PASSWORD) =>
  openHalotSession({ host: '127.0.0.1', port, password, timeoutMs: 400 })

test('the version is read before any token leaves', async (t) => {
  const sim = await simulator(t)
  const session = await open(sim.port)
  t.after(session.close)
  assert.deepEqual(sim.received, [{ cmd: 'VERSION_CHECK' }])
  assert.equal((await session.readStatus()).printStatus, 'PRINT_GENERAL')
  assert.deepEqual(sim.received[1], {
    cmd: 'GET_PRINT_STATUS',
    token: HALOT_SIMULATOR_TOKEN,
  })
})

test('an unknown protocol version never receives a token', async (t) => {
  const sim = await simulator(t, { version: '2' })
  await assert.rejects(open(sim.port), /Unsupported HALOT protocol version/)
  assert.deepEqual(sim.received, [{ cmd: 'VERSION_CHECK' }])
})

test('the second token form is tried once, then kept', async (t) => {
  const appended = VECTORS[4][1]
  const sim = await simulator(t, { token: appended })
  const session = await open(sim.port)
  t.after(session.close)
  await session.readStatus()
  await session.readStatus()
  assert.deepEqual(
    sim.received.slice(1).map((message) => message.token),
    [HALOT_SIMULATOR_TOKEN, appended, appended],
  )
})

test('a refused password fails without a third try or a write', async (t) => {
  const sim = await simulator(t)
  const session = await open(sim.port, 'wrong12')
  await assert.rejects(session.readStatus(), HalotTokenError)
  assert.equal(sim.received.length, 3)
  assert.equal(
    session.write('PRINT_STOP', () => true),
    false,
  )
  assert.deepEqual(sim.writes(), [])
})

test('no command is written before a token is accepted', async (t) => {
  const sim = await simulator(t)
  const session = await open(sim.port)
  t.after(session.close)
  let guarded = false
  assert.equal(
    session.write('PRINT_STOP', () => (guarded = true)),
    false,
  )
  assert.equal(guarded, false)
  assert.deepEqual(sim.writes(), [])
})

test('silence, a malformed frame and a lost link end the session', async (t) => {
  for (const [fault, message] of [
    ['timeout', /timed out/],
    ['malformed', /Malformed HALOT frame/],
    ['disconnect', /connection/],
  ] as const) {
    const sim = await simulator(t)
    const session = await open(sim.port)
    t.after(session.close)
    await session.readStatus()
    sim.setFault(fault)
    await assert.rejects(session.readStatus(), message, fault)
    sim.setFault()
    await assert.rejects(session.readStatus(), /closed/, fault)
  }
})

const reply = (
  printStatus: string,
  more: Partial<HalotStatusReply> = {},
): HalotStatusReply => ({ cmd: 'GET_PRINT_STATUS', printStatus, ...more })
const layers = {
  filename: 'part.cxdlpv4',
  curSliceLayer: 50,
  sliceLayerCount: 200,
  printRemainTime: 2700,
}

test('each printStatus word has one reading', () => {
  for (const [word, state] of [
    ['PRINT_GENERAL', 'unknown'],
    ['PRINT_PROCESSING', 'printing'],
    ['PRINT_COMPLETING', 'printing'],
    ['PRINT_PAUSE', 'paused'],
    ['PRINT_STOP', 'paused'],
    ['PRINT_STOPING', 'unknown'],
    ['PRINT_COMPLETE', 'idle'],
    ['PRINT_END', 'idle'],
    ['PRINT_FAIL', 'error'],
    ['PRINT_SOMETHING_NEW', 'unknown'],
  ] as const) {
    const status = halotStatus(reply(word, layers))
    assert.equal(status.state, state, word)
    // Each reading is publishable.
    PrinterState.parse({
      printerKey: 'halot',
      ...status,
      identity: { vendor: 'Creality', model: 'HALOT-X1' },
      statusReason: 'halot-unqualified',
      controls: [],
      observedAt: 0,
    })
  }
  assert.deepEqual(halotStatus(reply('PRINT_GENERAL', { filename: '' })), {
    state: 'idle',
  })
  assert.deepEqual(halotStatus(reply('PRINT_PROCESSING', layers)), {
    state: 'printing',
    filename: 'part.cxdlpv4',
    progress: 0.25,
    currentLayer: 50,
    totalLayer: 200,
    estimatedRemainingSeconds: 2700,
  })
  assert.match(
    halotStatus(reply('PRINT_STOP', layers)).statusMessage!,
    /pausada ou interrompida/,
  )
  // Progress is never invented from a missing or impossible layer position.
  for (const more of [
    {},
    { curSliceLayer: 1 },
    { curSliceLayer: 0, sliceLayerCount: 0 },
    { curSliceLayer: 201, sliceLayerCount: 200 },
  ])
    assert.equal(
      halotStatus(reply('PRINT_PROCESSING', more)).state,
      'unknown',
      JSON.stringify(more),
    )
})

async function credentials(t: TestContext, origin: string) {
  const directory = await mkdtemp(join(tmpdir(), 'halot-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const passwordFile = join(directory, 'halot.json')
  await writeFile(
    passwordFile,
    JSON.stringify({ origin, password: HALOT_SIMULATOR_PASSWORD }),
    { mode: 0o600 },
  )
  return {
    family: 'halot' as const,
    printerKey: 'halot',
    origin,
    passwordFile,
    simulated: true,
    expect: { model: 'HALOT-MAGE PRO' as const },
  }
}

test('only the four catalog models at a local address are accepted', async (t) => {
  assert.deepEqual(HALOT_MODEL_NAMES, [
    'HALOT-X1 Max',
    'HALOT-X1',
    'HALOT-MAGE S',
    'HALOT-MAGE PRO',
  ])
  const binding = await credentials(t, 'ws://192.168.1.50:18188')
  for (const model of HALOT_MODEL_NAMES)
    Binding.parse({ ...binding, expect: { model } })
  for (const change of [
    { expect: { model: 'HALOT-MAGE' } },
    { expect: { model: 'HALOT R6' } },
    { origin: 'ws://8.8.8.8:18188' },
    { origin: 'ws://printer.local:18188' },
    { origin: 'http://192.168.1.50:18188' },
    { origin: 'ws://192.168.1.50:18188/path' },
    { passwordFile: 'relative.json' },
    { password: 'inline' },
  ])
    assert.equal(
      Binding.safeParse({ ...binding, ...change }).success,
      false,
      JSON.stringify(change),
    )
})

test('the password file must be private and name the same printer', async (t) => {
  const binding = await credentials(t, 'ws://192.168.1.50:18188')
  assert.equal(readHalotPassword(binding), HALOT_SIMULATOR_PASSWORD)
  const refused = /^Error: Invalid private HALOT password file$/
  assert.throws(
    () => readHalotPassword({ ...binding, origin: 'ws://192.168.1.51:18188' }),
    refused,
  )
  await chmod(binding.passwordFile, 0o644)
  assert.throws(() => readHalotPassword(binding), refused)
})

type Seen = Parameters<
  Parameters<typeof createHalotCollection>[0]['onObservation']
>[0]['printer']

async function until(condition: () => boolean) {
  const deadline = performance.now() + 5000
  while (!condition()) {
    assert.ok(performance.now() < deadline, 'condition never became true')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('status is read-only, withdrawn on loss and recovered', async (t) => {
  const sim = await simulator(t)
  sim.beginPrint('part.cxdlpv4')
  const binding = await credentials(t, `ws://127.0.0.1:${sim.port}`)
  const controller = new AbortController()
  const seen: Seen[] = []
  const lost: number[] = []
  const collection = createHalotCollection({
    binding,
    allowedOrigins: [binding.origin],
    signal: controller.signal,
    timeoutMs: 500,
    pollMs: 20,
    onObservation: ({ printer }) => seen.push(printer),
    onUnavailable: (epoch) => lost.push(epoch),
  })
  t.after(async () => {
    controller.abort()
    await collection.done
  })

  await until(() => seen.length > 0)
  const { observedAt, ...printer } = seen[0]!
  assert.ok(observedAt > 0)
  assert.deepEqual(printer, {
    printerKey: 'halot',
    state: 'printing',
    filename: 'part.cxdlpv4',
    progress: 0.25,
    currentLayer: 50,
    totalLayer: 200,
    estimatedRemainingSeconds: 2700,
    identity: { vendor: 'Creality', model: 'HALOT-MAGE PRO' },
    controls: [],
    statusReason: 'halot-simulated',
  })
  // Every reading the collector can publish is a valid printer state.
  PrinterState.parse(seen[0])

  sim.setFault('disconnect')
  await until(() => lost.length === 1)
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.deepEqual(lost, [1], 'one withdrawal per outage')

  sim.idle()
  sim.setFault()
  const before = seen.length
  await until(() => seen.length > before)
  assert.equal(seen.at(-1)!.state, 'idle')
  assert.equal(seen.at(-1)!.progress, undefined)
  PrinterState.parse(seen.at(-1))

  sim.machine.printStatus = 'PRINT_FAIL'
  await until(() => seen.at(-1)!.state === 'error')
  PrinterState.parse(seen.at(-1))

  sim.setFault('timeout')
  await until(() => lost.length === 2)
  assert.deepEqual(lost, [1, 2])
  assert.deepEqual(sim.writes(), [])
  assert.equal(sim.binaryFrames(), 0)
})

test('every catalog model reports the declared identity read-only', async (t) => {
  const sim = await simulator(t)
  sim.beginPrint('part.cxdlpv4')
  const binding = await credentials(t, `ws://127.0.0.1:${sim.port}`)
  for (const model of HALOT_MODEL_NAMES) {
    const controller = new AbortController()
    const seen: Seen[] = []
    const collection = createHalotCollection({
      binding: { ...binding, simulated: false, expect: { model } },
      allowedOrigins: [binding.origin],
      signal: controller.signal,
      timeoutMs: 500,
      pollMs: 20,
      onObservation: ({ printer }) => seen.push(printer),
      onUnavailable: () => assert.fail(`${model} unavailable`),
    })
    await until(() => seen.length > 0)
    controller.abort()
    await collection.done
    assert.deepEqual(seen[0]!.identity, { vendor: 'Creality', model })
    assert.equal(seen[0]!.statusReason, 'halot-unqualified')
    assert.deepEqual(seen[0]!.controls, [])
    PrinterState.parse(seen[0])
  }
  assert.deepEqual(sim.writes(), [])
})
