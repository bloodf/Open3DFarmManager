// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { provisionKobraXPrinter } from '../../packages/connector/src/control/printer-binding.ts'
import type { ControlObservation } from '../../packages/connector/src/control/pause-dispatcher.ts'
import { openFixedKobraXControl } from '../../packages/connector/src/kobra-x/control-driver.ts'
import type { connectKobraX } from '../../packages/connector/src/kobra-x/index.ts'
import { createKobraXFacts } from '../../packages/connector/src/kobra-x/facts.ts'
import {
  createKobraXRequests,
  parseKobraXReport,
  type KobraXReport,
} from '../../packages/connector/src/kobra-x/requests.ts'
import {
  createKobraXQueryEvidence,
  createKobraXStateEvidence,
} from '../../packages/connector/src/kobra-x/state-evidence.ts'
import {
  mqttPublish,
  mqttReader,
  takeMqttPackets,
} from '../fixtures/kobralink-integration/mqtt-wire.ts'

function frame(
  type: string,
  action: string,
  msgid: string,
  data: Record<string, unknown> = {},
  state = 'done',
  code = 200,
): KobraXReport {
  const bytes = mqttPublish(
    `${type}/report`,
    JSON.stringify({ type, action, msgid, data, state, code }),
  )
  const packet = takeMqttPackets(bytes, 65536).packets[0]!
  const reader = mqttReader(packet.body)
  const topicType = reader.field()!.toString().split('/')[0]!
  return parseKobraXReport(topicType, JSON.parse(reader.rest().toString()))!
}

for (const [label, type, action] of [
  ['wrong type', 'info', 'start'],
  ['wrong action', 'print', 'stop'],
] as const) {
  test(`${label} cannot settle a command`, async () => {
    let id = ''
    let sends = 0
    const requests = createKobraXRequests({
      topic: (type) => type,
      publish(_topic, payload) {
        sends++
        id = JSON.parse(payload).msgid
      },
      resultTimeoutMs: 20,
    })
    const result = requests.send({
      type: 'print',
      action: 'start',
      beforeSend: () => true,
    })
    requests.handleAck({ msgid: id, code: 0 })
    requests.handleReport(frame(type, action, id))
    assert.equal((await result).kind, 'received')
    assert.equal(sends, 1)
  })
}

test('by default a printer-chosen or missing ID never settles a command', async () => {
  for (const msgid of ['printer-chosen', '']) {
    let id = ''
    const requests = createKobraXRequests({
      topic: (type) => type,
      publish(_topic, payload) {
        id = JSON.parse(payload).msgid
      },
      resultTimeoutMs: 20,
    })
    const result = requests.send({
      type: 'print',
      action: 'stop',
      beforeSend: () => true,
    })
    requests.handleAck({ msgid: id, code: 0 })
    requests.handleReport(frame('print', 'stop', msgid))
    assert.equal((await result).kind, 'received')
  }
})

test('a report owned by another pending request cannot settle a command', async () => {
  const ids: string[] = []
  const requests = createKobraXRequests({
    topic: (type) => type,
    publish(_topic, payload) {
      ids.push(JSON.parse(payload).msgid)
    },
    resultTimeoutMs: 40,
  })
  const spec = {
    type: 'print',
    action: 'start',
    beforeSend: () => true,
  }
  const first = requests.send(spec)
  const second = requests.send(spec)
  requests.handleReport(frame('print', 'start', ids[1]!))
  const confirmed = await second
  assert.equal(confirmed.kind, 'confirmed')
  assert.equal(confirmed.kind === 'confirmed' && confirmed.correlated, true)
  assert.equal((await first).kind, 'unanswered')
})

test('on printer-assigned firmware, a printer-chosen or missing ID settles by type and action, uncorrelated', async () => {
  for (const msgid of ['printer-chosen', '']) {
    let id = ''
    const requests = createKobraXRequests({
      topic: (type) => type,
      publish(_topic, payload) {
        id = JSON.parse(payload).msgid
      },
      resultTimeoutMs: 40,
      reportIdentity: 'printer-assigned',
    })
    const result = requests.send({
      type: 'print',
      action: 'stop',
      beforeSend: () => true,
    })
    requests.handleAck({ msgid: id, code: 0 })
    requests.handleReport(frame('print', 'stop', msgid))
    const outcome = await result
    assert.equal(outcome.kind, 'confirmed')
    assert.equal(outcome.kind === 'confirmed' && outcome.correlated, false)
  }
})

test('on printer-assigned firmware, a failed report without an ID still refuses and a wrong action never does', async () => {
  let id = ''
  const requests = createKobraXRequests({
    topic: (type) => type,
    publish(_topic, payload) {
      id = JSON.parse(payload).msgid
    },
    resultTimeoutMs: 40,
    reportIdentity: 'printer-assigned',
  })
  const result = requests.send({
    type: 'print',
    action: 'stop',
    beforeSend: () => true,
  })
  requests.handleAck({ msgid: id, code: 0 })
  requests.handleReport(frame('print', 'pause', '', {}, 'failed', 500))
  requests.handleReport(frame('print', 'stop', '', {}, 'failed', 500))
  assert.deepEqual(await result, {
    kind: 'refused',
    stage: 'printer',
    reason: 'printer-refused',
    code: 500,
  })
})

test('a failed free report invalidates readiness and cannot update facts', () => {
  const evidence = createKobraXStateEvidence()
  const facts = createKobraXFacts()
  const failed = frame(
    'info',
    'report',
    'failed',
    { state: 'free' },
    'done',
    500,
  )
  evidence.report(failed, true)
  facts.report(failed)
  assert.equal(evidence.get(), undefined)
  assert.equal(facts.get().infoState, undefined)
  evidence.reset()
  evidence.report(frame('info', 'report', 'good', { state: 'free' }), true)
  assert.equal(evidence.get()?.printState, 'idle')
  evidence.report(failed, false)
  assert.equal(evidence.get(), undefined)
})

test('an older or already consumed reply cannot override current state', () => {
  const queries = createKobraXQueryEvidence()
  const evidence = createKobraXStateEvidence()
  queries.issue('info', 'old')
  queries.issue('info', 'new')
  queries.issue('print', 'active')
  const deliver = (report: KobraXReport) => {
    const match = queries.classify(report)
    if (match !== 'stale') evidence.report(report, match === 'current')
  }
  deliver(frame('info', 'report', 'new', { state: 'busy' }))
  deliver(
    frame('print', 'query', 'active', { filename: 'part.gcode' }, 'printing'),
  )
  deliver(frame('info', 'report', 'old', { state: 'free' }))
  deliver(frame('info', 'report', 'new', { state: 'free' }))
  assert.equal(evidence.get()?.printState, 'printing')
})

function driverFixture(
  t: TestContext,
  initiallyPrinting = false,
  refreshedTask = 'existing',
  settledBy: 'exact' | 'type-action' = 'exact',
) {
  const directory = mkdtempSync(join(tmpdir(), 'kobra-x-command-evidence-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const cert = join(directory, 'client.json')
  const fingerprint = 'a'.repeat(64)
  writeFileSync(
    cert,
    JSON.stringify({
      version: 1,
      format: 'pem',
      subject: 'CN=AnycubicSlicer',
      commonName: 'AnycubicSlicer',
      notBefore: 1,
      notAfter: Date.now() + 60000,
      notBeforeIso: 'synthetic',
      notAfterIso: 'synthetic',
      fingerprintSha256: fingerprint,
      certificatePem: 'synthetic',
      keyPem: 'synthetic',
    }),
    { mode: 0o600 },
  )
  const binding = provisionKobraXPrinter(
    {
      assignment_id: randomUUID(),
      farm_id: randomUUID(),
      agent_id: randomUUID(),
      printer_key: 'synthetic',
    },
    {
      printerKey: 'synthetic',
      host: '127.0.0.1',
      modelId: '20030',
      deviceId: 'synthetic',
      clientCertFile: cert,
      pinSha256: fingerprint,
    },
  )
  const facts = createKobraXFacts()
  const signal = new AbortController().signal
  let mono = 1
  let published: ControlObservation | null = null
  let sends = 0
  let onReport: NonNullable<Parameters<typeof connectKobraX>[0]['onReport']>
  const report = (
    value: KobraXReport,
    source: 'query' | 'request' | 'other',
  ) => {
    facts.report(value)
    onReport(value, {} as Parameters<typeof onReport>[1], facts.get(), source)
  }
  const command = openFixedKobraXControl({
    binding,
    connectionGeneration: 1,
    clock: { monotonicNow: () => ++mono },
    signal,
    publish: (value) => {
      published = value
    },
    async connect(options) {
      onReport = options.onReport!
      report(
        frame('info', 'report', 'initial', {
          state: initiallyPrinting ? 'busy' : 'free',
        }),
        'query',
      )
      if (initiallyPrinting) {
        report(
          frame(
            'print',
            'query',
            'initial-job',
            { filename: 'part.gcode', taskid: 'existing' },
            'printing',
          ),
          'query',
        )
      }
      return {
        close: async () => {},
        refreshControlState() {
          if (sends && start) {
            report(
              frame('info', 'report', 'new-info', { state: 'busy' }),
              'query',
            )
            report(
              frame(
                'print',
                'query',
                'new-print',
                { filename: 'part.gcode', taskid: refreshedTask },
                'printing',
              ),
              'query',
            )
          } else {
            report(
              frame('info', 'report', 'new-info', { state: 'free' }),
              'query',
            )
            report(
              frame('tempature', 'query', 'new-temperature', {
                target_nozzle_temp: 190,
              }),
              'query',
            )
          }
        },
        control: {
          async execute(action, _args, call) {
            if (!call.beforeSend())
              return {
                kind: 'refused',
                stage: 'local',
                reason: 'not-authorized',
              }
            sends++
            start = action === 'start_print'
            const light = action === 'set_light'
            const result = light
              ? frame('light', 'control', 'command', { status: 1 })
              : start
                ? frame(
                    'print',
                    'start',
                    'command',
                    { filename: 'part.gcode', taskid: 'new-job' },
                    'checking',
                  )
                : frame('tempature', 'set', 'command', {
                    target_nozzle_temp: 190,
                  })
            report(result, settledBy === 'exact' ? 'request' : 'other')
            return {
              kind: 'confirmed',
              report: result,
              correlated: settledBy === 'exact',
              data: undefined,
              effectMatches: light
                ? (next) => next.data.status === 1
                : (next) => next.data.target_nozzle_temp === 190,
            }
          },
        },
      } satisfies Pick<
        Awaited<ReturnType<typeof connectKobraX>>,
        'close' | 'refreshControlState'
      > & {
        control: Pick<
          Awaited<ReturnType<typeof connectKobraX>>['control'],
          'execute'
        >
      } as Awaited<ReturnType<typeof connectKobraX>>
    },
  })
  let start = false
  t.after(() => command.close())
  return {
    ...command,
    report,
    sends: () => sends,
    published: () => published,
    request: { binding, signal, beforeSend: () => true },
    cursor: () => ({
      sequence: published!.sequence,
      connectionGeneration: 1,
      sentMono: mono,
    }),
  }
}

test('a pre-existing same-filename print cannot confirm start_print', async (t) => {
  const fixture = driverFixture(t, true)
  await fixture.prepare()
  assert.deepEqual(
    await fixture.driver.execute!(
      'start_print',
      { file: 'part.gcode' },
      fixture.request,
    ),
    { acknowledged: false },
  )
  assert.equal(fixture.sends(), 0)
})

test('a same-filename job with a different task ID cannot confirm a sent start', async (t) => {
  const fixture = driverFixture(t)
  await fixture.prepare()
  assert.deepEqual(
    await fixture.driver.execute!(
      'start_print',
      { file: 'part.gcode' },
      fixture.request,
    ),
    { acknowledged: false },
  )
  assert.equal(fixture.sends(), 1)
})

test('a changed effect between acknowledgement and final confirmation stays uncertain', async (t) => {
  const fixture = driverFixture(t)
  await fixture.prepare()
  const after = fixture.cursor()
  assert.deepEqual(
    await fixture.driver.execute!(
      'set_temperature',
      { heater: 'extruder', target_c: 190 },
      fixture.request,
    ),
    { acknowledged: true },
  )
  fixture.report(
    frame('tempature', 'report', 'changed', { target_nozzle_temp: 180 }),
    'other',
  )
  assert.equal(
    await fixture.driver.waitForPaused({ ...fixture.request, after }),
    null,
  )
  assert.equal(fixture.sends(), 1)
})

test('a new correlated job can confirm the start', async (t) => {
  const fixture = driverFixture(t, false, 'new-job')
  await fixture.prepare()
  const after = fixture.cursor()
  assert.deepEqual(
    await fixture.driver.execute!(
      'start_print',
      { file: 'part.gcode' },
      fixture.request,
    ),
    { acknowledged: true },
  )
  assert.equal(
    (await fixture.driver.waitForPaused({ ...fixture.request, after }))?.effect
      ?.kind,
    'file',
  )
})

test('a contradictory current reply invalidates readiness', () => {
  const evidence = createKobraXStateEvidence()
  evidence.report(frame('info', 'report', 'info', { state: 'free' }), true)
  assert.equal(evidence.get()?.printState, 'idle')
  evidence.report(
    frame('print', 'query', 'print', { filename: 'part.gcode' }, 'printing'),
    true,
  )
  assert.equal(evidence.get(), undefined)
})

test('a control settled only by type and action is not effect evidence', async (t) => {
  const exact = driverFixture(t, false, 'existing', 'exact')
  await exact.prepare()
  assert.deepEqual(
    await exact.driver.execute!('set_light', { on: true }, exact.request),
    { acknowledged: true },
  )
  const fallback = driverFixture(t, false, 'existing', 'type-action')
  await fallback.prepare()
  assert.deepEqual(
    await fallback.driver.execute!('set_light', { on: true }, fallback.request),
    { acknowledged: false },
  )
  assert.equal(fallback.sends(), 1)
})

test('a fresh correlated state read-back confirms a control the fallback settled', async (t) => {
  const fixture = driverFixture(t, false, 'existing', 'type-action')
  await fixture.prepare()
  assert.deepEqual(
    await fixture.driver.execute!(
      'set_temperature',
      { heater: 'extruder', target_c: 190 },
      fixture.request,
    ),
    { acknowledged: true },
  )
  assert.equal(fixture.sends(), 1)
})
