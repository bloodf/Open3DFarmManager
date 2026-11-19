// SPDX-License-Identifier: MIT
// Step catalog and summary formatting for `npm run desktop:check`.

export type StepStatus = 'passed' | 'failed' | 'skipped'

export interface StepDefinition {
  readonly name: string
  readonly title: string
  /** Program and arguments; absent for the in-process preflight. */
  readonly command?: readonly [string, ...string[]]
  /** Steps that must have passed (when selected) for this one to run. */
  readonly needs?: readonly string[]
  readonly timeoutMs: number
}

const minutes = (value: number) => value * 60_000

export const STEPS: readonly StepDefinition[] = [
  {
    name: 'preflight',
    title: 'Toolchain and offline policy',
    timeoutMs: minutes(2),
  },
  {
    name: 'lint',
    title: 'npm run lint',
    command: ['npm', 'run', 'lint'],
    timeoutMs: minutes(10),
  },
  {
    name: 'typecheck',
    title: 'npm run typecheck',
    command: ['npm', 'run', 'typecheck'],
    timeoutMs: minutes(20),
  },
  {
    name: 'vitest',
    title: 'npm test (vitest)',
    command: ['npm', 'test'],
    timeoutMs: minutes(20),
  },
  {
    name: 'test-node',
    title: 'npm run test:node',
    command: ['npm', 'run', 'test:node'],
    timeoutMs: minutes(45),
  },
  {
    name: 'rtsp-supervisor',
    title: 'npm run test:rtsp-supervisor',
    command: ['npm', 'run', 'test:rtsp-supervisor'],
    timeoutMs: minutes(10),
  },
  {
    name: 'rtsp-framing',
    title: 'npm run test:rtsp-framing',
    command: ['npm', 'run', 'test:rtsp-framing'],
    timeoutMs: minutes(10),
  },
  {
    name: 'build',
    title: 'npm run build',
    command: ['npm', 'run', 'build'],
    timeoutMs: minutes(20),
  },
  {
    name: 'build-rtsp-ingest',
    title: 'npm run build:rtsp-ingest (needs Go)',
    command: ['npm', 'run', 'build:rtsp-ingest'],
    timeoutMs: minutes(10),
  },
  {
    name: 'test-postgres',
    title: 'npm run test:postgres (local cluster)',
    command: ['npm', 'run', 'test:postgres'],
    timeoutMs: minutes(60),
  },
  {
    name: 'test-e2e',
    title: 'npm run test:e2e (system Chrome)',
    command: ['npm', 'run', 'test:e2e'],
    needs: ['build'],
    timeoutMs: minutes(45),
  },
  {
    name: 'test-journey',
    title: 'npm run test:journey (mocks)',
    command: ['npm', 'run', 'test:journey'],
    needs: ['build'],
    timeoutMs: minutes(45),
  },
  {
    name: 'test-sim-farm',
    title: 'npm run test:sim-farm (mocks)',
    command: ['npm', 'run', 'test:sim-farm'],
    needs: ['build'],
    timeoutMs: minutes(20),
  },
  {
    name: 'app-smoke',
    title: 'built app + Connector on mocks, /healthz, farm page in Chrome',
    command: ['node', 'scripts/desktop-check-smoke.ts'],
    needs: ['build'],
    timeoutMs: minutes(10),
  },
]

/** Test hook: a child that swallows a blocked `fetch` and still exits 0. */
export const GUARD_PROBE_STEP: StepDefinition = {
  name: 'network-guard-probe',
  title: "deliberate outbound fetch('https://example.com')",
  command: [
    'node',
    '-e',
    "fetch('https://example.com').then(() => {}, () => {})",
  ],
  timeoutMs: minutes(1),
}

export interface StepResult {
  readonly name: string
  readonly title: string
  readonly status: StepStatus
  readonly durationMs: number
  /** Skip reason or failure cause. */
  readonly reason?: string
  readonly logPath?: string
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)} s`
  return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`
}

export function formatSummary(results: readonly StepResult[]): string {
  const width = Math.max(...results.map((result) => result.name.length), 4)
  const rows = results.map((result) => {
    const note = result.reason ? `  ${result.reason}` : ''
    return `${result.name.padEnd(width)}  ${result.status.toUpperCase().padEnd(7)}  ${formatDuration(result.durationMs).padStart(10)}${note}`
  })
  return [
    `${'step'.padEnd(width)}  ${'status'.padEnd(7)}  ${'duration'.padStart(10)}  note`,
    ...rows,
  ].join('\n')
}
