import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parse } from 'yaml'
import {
  deferredAcceptanceRows,
  HARDWARE_ACCEPTANCE_DEFERRED,
  NETWORK_FAULT_PROFILES,
} from '../../scripts/rtc-farm-all-mode.ts'

const simSource = readFileSync(
  new URL('../../.github/workflows/sim.yml', import.meta.url),
  'utf8',
)

type WorkflowStep = {
  name?: string
  run?: string
  uses?: string
  if?: string
  with?: Record<string, string>
}

type WorkflowJob = {
  if?: string
  env?: Record<string, string>
  'runs-on'?: string
  'timeout-minutes'?: number
  steps?: WorkflowStep[]
}

type Workflow = {
  on?: unknown
  permissions?: Record<string, string>
  jobs?: Record<string, WorkflowJob>
}

const workflow = parse(simSource) as Workflow
const jobs = workflow.jobs ?? {}

test('Simulator workflow stays dispatch-only', () => {
  assert.deepEqual(workflow.on, ['workflow_dispatch'])
  assert.equal(workflow.permissions?.contents, 'read')
  assert.doesNotMatch(simSource, /\bon:\s*\n?\s*pull_request\b/)
  assert.doesNotMatch(simSource, /\bpush:\s/)
})

test('network-fault job runs Docker-only acceptance on ubuntu-24.04', () => {
  const job = jobs['network-fault']
  assert.ok(job, 'sim.yml must define network-fault')
  assert.equal(job.if, "github.event_name == 'workflow_dispatch'")
  assert.equal(job['runs-on'], 'ubuntu-24.04')
  assert.equal(job['timeout-minutes'], 30)
  assert.equal(job.env?.OPENFARM_SIM, 'docker')
  assert.match(
    job.env?.RTC_FARM_TEST_ALL_EVIDENCE ?? '',
    /sim-diagnostics\/network-fault/,
  )
  assert.match(
    job.env?.RTC_FARM_TEST_ALL_SUMMARY ?? '',
    /sim-diagnostics\/network-fault\/summary\.json/,
  )

  const steps = job.steps ?? []
  assert.equal(
    steps[0]?.uses,
    'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
  )
  assert.equal(
    steps[1]?.uses,
    'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
  )
  assert.equal(steps[1]?.with?.['node-version'], '22.23.5')
  assert.equal(steps[2]?.run, 'npm ci --ignore-scripts --include=optional')

  const runStep = steps.find((step) =>
    /test-rtc-farm-acceptance\.ts --network-fault/.test(step.run ?? ''),
  )
  assert.ok(runStep, 'job must invoke --network-fault')
  assert.match(runStep.run ?? '', /mkdir -p sim-diagnostics\/network-fault/)

  const upload = steps.find(
    (step) =>
      step.if === 'always()' &&
      typeof step.uses === 'string' &&
      step.uses.startsWith('actions/upload-artifact@'),
  )
  assert.ok(upload, 'job must upload evidence always')
  assert.equal(
    upload.uses,
    'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
  )
  assert.equal(upload.with?.name, 'sim-network-fault')
  assert.equal(upload.with?.path, 'sim-diagnostics/network-fault/')
  assert.equal(Number(upload.with?.['retention-days']), 7)
})

test('mock mode still defers network-fault profiles and the E13.1 hardware row', () => {
  const deferred = deferredAcceptanceRows({ OPENFARM_SIM: 'mock' })
  assert.deepEqual(
    deferred.map((row) => ({ suite: row.suite, row: row.row })),
    [
      ...NETWORK_FAULT_PROFILES.map((row) => ({
        suite: 'network-fault',
        row,
      })),
      {
        suite: HARDWARE_ACCEPTANCE_DEFERRED.suite,
        row: HARDWARE_ACCEPTANCE_DEFERRED.row,
      },
    ],
  )
  for (const profile of NETWORK_FAULT_PROFILES) {
    const entry = deferred.find((row) => row.row === profile)
    assert.equal(entry?.detail, 'Docker mode only (OPENFARM_SIM=docker)')
  }
  assert.equal(deferred.at(-1)?.row, 'E13.1-owner-hardware-acceptance')

  const dockerDeferred = deferredAcceptanceRows({ OPENFARM_SIM: 'docker' })
  assert.deepEqual(
    dockerDeferred.map((row) => row.row),
    ['E13.1-owner-hardware-acceptance'],
  )
})
