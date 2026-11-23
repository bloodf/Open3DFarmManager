// Command-line parsing for run-polish-docker.mjs.
import { parseArgs } from 'node:util'

export const USAGE = `Usage: node tests/e2e/run-polish-docker.mjs --screen <name> --spec <path> --baseline <sha> [options]

Required:
  --screen <name>         Screen name; used in temp/container names and as the
                          default shots env var POLISH_<NAME>_SHOTS_DIR.
  --spec <path>           Playwright spec, relative to the repo root.
  --baseline <sha>        Commit of the pre-polish tree (must be an ancestor of HEAD).

Options:
  --min-shots <n>         Minimum screenshots per phase (default 8).
  --min-before-shots <n>  Minimum baseline screenshots (default: --min-shots).
  --shots-env <NAME>      Env var through which the spec reads its screenshot
                          directory (default POLISH_<SCREEN>_SHOTS_DIR).
  --capture-grep <regex>  Baseline capture: run only the spec tests matching this
                          title, tolerating failures of the other assertions
                          (default 'screenshots of real screen states').
  --capture-script <path> Baseline capture: run this script instead of the spec,
                          as 'node <script> <output-dir>' (must exit 0).
  --page <path>           Repeatable. Page that must differ between baseline and HEAD.
  --unit <args>           Repeatable. Extra vitest arguments (whitespace-separated),
                          run on host Node 22 against the after tree.
`

const positiveInt = (name, value, fallback) => {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`--${name} must be a positive integer, got "${value}"`)
  return parsed
}

export function parseRunnerArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      screen: { type: 'string' },
      spec: { type: 'string' },
      baseline: { type: 'string' },
      'min-shots': { type: 'string' },
      'min-before-shots': { type: 'string' },
      'shots-env': { type: 'string' },
      'capture-grep': { type: 'string' },
      'capture-script': { type: 'string' },
      page: { type: 'string', multiple: true },
      unit: { type: 'string', multiple: true },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  })
  if (values.help) return { help: true }
  for (const required of ['screen', 'spec', 'baseline'])
    if (!values[required]) throw new Error(`--${required} is required`)
  if (!/^[a-z][a-z0-9-]*$/.test(values.screen))
    throw new Error('--screen must be lowercase letters, digits and dashes')
  const minShots = positiveInt('min-shots', values['min-shots'], 8)
  return {
    screen: values.screen,
    spec: values.spec,
    baseline: values.baseline,
    minShots,
    minBeforeShots: positiveInt(
      'min-before-shots',
      values['min-before-shots'],
      minShots,
    ),
    shotsEnv:
      values['shots-env'] ??
      `POLISH_${values.screen.toUpperCase().replaceAll('-', '_')}_SHOTS_DIR`,
    captureGrep: values['capture-grep'] ?? 'screenshots of real screen states',
    captureScript: values['capture-script'],
    pages: values.page ?? [],
    units: (values.unit ?? []).map((entry) =>
      entry.split(/\s+/).filter(Boolean),
    ),
  }
}
