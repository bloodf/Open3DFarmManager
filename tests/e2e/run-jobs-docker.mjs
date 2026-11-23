// Jobs history screen (/historico) evidence, run against Docker on Node 22 only.
//
//   node tests/e2e/run-jobs-docker.mjs
//
// Thin wrapper over the shared runner (run-polish-docker.mjs, see its header
// for the phases and isolation): before is the pre-polish baseline, captured by
// polish-jobs-capture.ts; after is HEAD with polish-jobs.spec.ts passing; both
// must leave all 28 screenshots. The page, shot count and the vitest runs that
// keep covering this page are passed through unchanged.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Last commit before the jobs screen was polished.
const BASELINE_SHA = '5f356def2ae102d559af1800878802e5bbd5052c'

const { status, signal } = spawnSync(
  process.execPath,
  [
    fileURLToPath(new URL('run-polish-docker.mjs', import.meta.url)),
    ...['--screen', 'jobs'],
    ...['--spec', 'tests/e2e/polish-jobs.spec.ts'],
    ...['--baseline', BASELINE_SHA],
    ...['--min-shots', '28'],
    ...['--capture-script', 'tests/e2e/polish-jobs-capture.ts'],
    ...['--page', 'apps/farm/app/pages/historico.vue'],
    ...[
      '--unit',
      'tests/unit/job-history.test.ts tests/unit/job-history-library-link.test.ts',
    ],
    ...[
      '--unit',
      'tests/unit/replay-wiring.test.ts tests/unit/page-states.test.ts -t historico|Histórico',
    ],
  ],
  { stdio: 'inherit' },
)
process.exit(status ?? (signal ? 1 : 0))
