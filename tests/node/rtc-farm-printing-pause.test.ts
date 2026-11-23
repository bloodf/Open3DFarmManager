import test from 'node:test'
import assert from 'node:assert/strict'
import {
  runPrintingPause,
  PAUSED_UI,
  type PauseEvidence,
} from '../helpers/rtc-farm-printing-pause.ts'
import { simulatorRtcFarmScenarios } from '../helpers/rtc-farm-acceptance-sim-scenarios.ts'

const applied = { cmd_id: 'command-1', status: 'applied', reason: 'applied' }
function fixture(evidence: PauseEvidence, confirmError = false) {
  const calls: string[] = []
  const notes: string[] = []
  let resumed = false
  return {
    calls,
    notes,
    input: {
      async start() {
        calls.push('start')
      },
      async confirm() {
        calls.push('confirm')
        if (confirmError) throw Error('Lost response: outcome uncertain')
      },
      async observe() {
        calls.push('observe')
        return resumed ? { ...evidence, klipper: 'printing' } : evidence
      },
      async resume() {
        calls.push('resume')
        resumed = true
      },
      async resumed() {
        calls.push('resumed')
      },
      async note(value: string) {
        notes.push(value)
      },
    },
  }
}

test('agreed Klipper, actual UI result and durable journal precede resume; records outcome', async () => {
  const f = fixture({ klipper: 'paused', ui: PAUSED_UI, journal: [applied] })
  await runPrintingPause(f.input)
  assert.deepEqual(f.calls, [
    'start',
    'confirm',
    'observe',
    'resume',
    'resumed',
    'observe',
  ])
  assert.deepEqual(f.notes, [
    'farm-page-printing-pause-outcome:' +
      JSON.stringify({ klipper: 'paused', ui: PAUSED_UI, journal: [applied] }),
    'farm-page-printing-pause-agreement-no-retry-resumed',
  ])
})

for (const evidence of [
  { klipper: 'printing', ui: PAUSED_UI, journal: [applied] },
  { klipper: 'paused', ui: 'Resultado desconhecido', journal: [applied] },
  { klipper: 'paused', ui: PAUSED_UI, journal: [] },
  {
    klipper: 'paused',
    ui: PAUSED_UI,
    journal: [applied, { ...applied, cmd_id: 'duplicate' }],
  },
  {
    klipper: 'paused',
    ui: PAUSED_UI,
    journal: [{ ...applied, status: 'outcome-unknown' }],
  },
  {
    klipper: 'paused',
    ui: PAUSED_UI,
    journal: [{ ...applied, reason: 'state-unconfirmed' }],
  },
])
  test(
    'disagreement fails without retry or resume: ' + JSON.stringify(evidence),
    async () => {
      const f = fixture(evidence)
      await assert.rejects(runPrintingPause(f.input))
      assert.deepEqual(f.calls, ['start', 'confirm', 'observe'])
      assert.equal(f.notes.length, 1)
    },
  )

test('uncertain confirmation is never repeated', async () => {
  const f = fixture(
    { klipper: 'paused', ui: PAUSED_UI, journal: [applied] },
    true,
  )
  await assert.rejects(runPrintingPause(f.input), /uncertain/)
  assert.deepEqual(f.calls, ['start', 'confirm', 'observe'])
  assert.match(f.notes[0]!, /^farm-page-printing-pause-uncertain:/)
})

test('late duplicate journal entry fails after resume', async () => {
  const f = fixture({ klipper: 'paused', ui: PAUSED_UI, journal: [applied] })
  let reads = 0
  f.input.observe = async () => ({
    klipper: ++reads === 1 ? 'paused' : 'printing',
    ui: PAUSED_UI,
    journal: reads === 1 ? [applied] : [applied, applied],
  })
  await assert.rejects(runPrintingPause(f.input))
  assert.equal(f.calls.filter((call) => call === 'confirm').length, 1)
  assert.equal(
    f.notes.some((note) => note.includes('agreement-no-retry-resumed')),
    false,
  )
})

test('real printing row requires explicit simulator opt-in and stays out of defaults', () => {
  const env = {
    RTC_FARM_TEST_SIM_MOONRAKER: 'http://127.0.0.1:23456',
    RTC_FARM_TEST_SIM_SPOOLMAN: 'http://127.0.0.1:23457',
  }
  assert.equal(
    simulatorRtcFarmScenarios(env)['farm-page-printing-pause'],
    undefined,
  )
  const row = simulatorRtcFarmScenarios({
    ...env,
    RTC_FARM_TEST_SIM_PRINTING_PAUSE: 'sv06',
    RTC_FARM_TEST_SIM_CONTAINER: 'a'.repeat(64),
  })['farm-page-printing-pause']!
  assert.deepEqual(row.resources, ['printing-simulator'])
  assert.equal(row.env.SIGNALLING_HTTPS_FARM_PAUSE, 'yes')
  assert.equal(
    row.env.SIGNALLING_HTTPS_SIM_MOONRAKER,
    env.RTC_FARM_TEST_SIM_MOONRAKER,
  )
  assert.equal(row.env.SIGNALLING_HTTPS_SIM_CONTAINER, 'a'.repeat(64))
})
