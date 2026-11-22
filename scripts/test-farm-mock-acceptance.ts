// One candidate for issue #9. Loopback mocks only. Hardware stays open.
import { spawnSync } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { mkdirSync, statfsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.env.OPENFARM_SIM === 'docker') {
  process.stderr.write('OPENFARM_SIM=docker is refused for issue #9\n')
  process.exit(2)
}

const head = execFileSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim()
const evidence =
  process.env.FARM_MOCK_EVIDENCE ??
  join(tmpdir(), 'o3dfm-issue9-farm-mock-accept-1c72ce2e170737ed')
mkdirSync(evidence, { recursive: true })

const tests = [
  'tests/node/farm-mock-issue9.test.ts',
  'tests/node/no-farmview-flag.test.ts',
]
const requirements = [
  {
    id: 'signed-pause-printing-mock',
    tests: ['signed pause against a printing Moonraker mock applies once'],
  },
  {
    id: 'reject-tampered',
    tests: ['tamper, scope and expiry never pause the printing mock'],
    reason: 'signature',
  },
  {
    id: 'reject-replayed',
    tests: ['signed pause against a printing Moonraker mock applies once'],
    reason: 'replay',
  },
  {
    id: 'reject-expired',
    tests: ['tamper, scope and expiry never pause the printing mock'],
    reason: 'expired',
  },
  {
    id: 'reject-wrong-farm',
    tests: ['tamper, scope and expiry never pause the printing mock'],
    reason: 'scope',
  },
  {
    id: 'reject-wrong-assignment',
    tests: ['tamper, scope and expiry never pause the printing mock'],
    reason: 'scope',
  },
  {
    id: 'reject-revoked',
    tests: ['revoked capability never pauses the printing mock'],
    reason: 'invalid-authority',
    note: 'Revoke makes capability inspection fail closed.',
  },
  {
    id: 'printer-ui-link',
    tests: ['printer UI link is the mock host without the API port'],
  },
  {
    id: 'tablet-layout',
    tests: ['tablet layout source contract is two columns from 48rem'],
    note: 'CSS source contract at min-width 48rem. Playwright farm-view render was not run.',
  },
  {
    id: 'farmview-flag-removed',
    tests: [
      'farmView flag name is absent from app code',
      'farmView flag name is absent from the README',
    ],
  },
]
const started = new Date()
const result = spawnSync(
  process.execPath,
  [
    '--test',
    '--test-concurrency=1',
    '--test-timeout=30000',
    '--test-force-exit',
    '--test-reporter=tap',
    ...tests,
  ],
  { encoding: 'utf8' },
)
if (result.stdout) process.stdout.write(result.stdout)
if (result.stderr) process.stderr.write(result.stderr)
let testResults: { name: string; ok: boolean }[] = []
for (const line of (result.stdout ?? '').split(/\r?\n/)) {
  const match = /^(ok|not ok) \d+ - (.+)$/.exec(line)
  if (match?.[1] && match[2]) {
    testResults.push({ name: match[2], ok: match[1] === 'ok' })
  }
}
if (testResults.length === 0) {
  process.stderr.write('Could not parse Node test TAP reporter output\n')
}
const requirementResults = requirements.map((requirement) => {
  const matched = requirement.tests.map((name) =>
    testResults.find((test) => test.name === name),
  )
  return {
    id: requirement.id,
    ...(requirement.reason ? { reason: requirement.reason } : {}),
    ...(requirement.note ? { note: requirement.note } : {}),
    status: matched.every((test) => test?.ok) ? 'pass' : 'fail',
  }
})
const disk = (path: string) => {
  const stats = statfsSync(path)
  return { path, freeBytes: stats.bavail * stats.bsize }
}
const ledger = {
  issue: 9,
  head,
  node: process.version,
  docker: false,
  physicalPrinter: false,
  network: 'loopback-only',
  openfarmSim: process.env.OPENFARM_SIM ?? 'unset',
  startedAt: started.toISOString(),
  finishedAt: new Date().toISOString(),
  exitCode: result.status,
  tests,
  rows: [
    ...requirementResults,
    { id: 'hardware-owner-run', status: 'open', ran: false },
    { id: 'github-actions', status: 'open', ran: false },
  ],
  disk: [disk(process.cwd()), disk(tmpdir())],
  evidence,
}
const ledgerPath = join(evidence, 'ledger.json')
writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n')
process.stdout.write(`${ledgerPath}\n`)
process.exit(
  result.status === 0 &&
    requirementResults.every((row) => row.status === 'pass')
    ? 0
    : (result.status ?? 1),
)
