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
const started = new Date()
const result = spawnSync(
  process.execPath,
  [
    '--test',
    '--test-concurrency=1',
    '--test-timeout=30000',
    '--test-force-exit',
    ...tests,
  ],
  { stdio: 'inherit' },
)
const passed = result.status === 0
const status = passed ? 'pass' : 'fail'
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
    { id: 'signed-pause-printing-mock', status },
    { id: 'reject-tampered', status, reason: 'signature' },
    { id: 'reject-replayed', status, reason: 'replay' },
    { id: 'reject-expired', status, reason: 'expired' },
    { id: 'reject-wrong-farm', status, reason: 'scope' },
    { id: 'reject-wrong-assignment', status, reason: 'scope' },
    {
      id: 'reject-revoked',
      status,
      reason: 'invalid-authority',
      note: 'Revoke makes capability inspection fail closed.',
    },
    { id: 'printer-ui-link', status },
    {
      id: 'tablet-layout',
      status,
      note: 'CSS source contract at min-width 48rem. Playwright farm-view render was not run.',
    },
    { id: 'farmview-flag-removed', status },
    { id: 'hardware-owner-run', status: 'open', ran: false },
    { id: 'github-actions', status: 'open', ran: false },
  ],
  disk: [disk(process.cwd()), disk(tmpdir())],
  evidence,
}
const ledgerPath = join(evidence, 'ledger.json')
writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n')
process.stdout.write(`${ledgerPath}\n`)
process.exit(result.status ?? 1)
