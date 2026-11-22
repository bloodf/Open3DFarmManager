import { isDockerSim } from '../packages/sim-tools/src/mocks/env.ts'
import { execFile } from 'node:child_process'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { RTC_FARM_SCENARIOS } from '../tests/helpers/rtc-farm-acceptance-scenarios.ts'
import { simulatorRtcFarmScenarios } from '../tests/helpers/rtc-farm-acceptance-sim-scenarios.ts'

const exec = promisify(execFile)
export type AcceptanceRow = {
  suite: string
  row: string
  passed: boolean
  detail?: string
}
export type AcceptanceSummary = {
  commit: string
  result: 'passed' | 'failed'
  rows: AcceptanceRow[]
}

export function allAcceptanceRows(env: NodeJS.ProcessEnv = process.env) {
  return [
    ...new Set([
      ...Object.keys(RTC_FARM_SCENARIOS),
      ...Object.keys(simulatorRtcFarmScenarios(env)),
      'farm-page-simulator-inventory',
      'farm-page-printing-pause',
    ]),
  ]
}

export function runnableAcceptanceRows(env: NodeJS.ProcessEnv = process.env) {
  return allAcceptanceRows(env).filter((row) => {
    if (env.OPENFARM_SIM?.trim().toLowerCase() !== 'docker') return true
    if (row === 'farm-page-camera')
      return Boolean(
        env.RTC_FARM_TEST_RTSP_HELPER && env.RTC_FARM_TEST_RTSP_PORT,
      )
    if (row === 'farm-page-simulator-inventory')
      return Boolean(
        env.RTC_FARM_TEST_SIM_MOONRAKER && env.RTC_FARM_TEST_SIM_SPOOLMAN,
      )
    if (row === 'farm-page-printing-pause')
      return Boolean(
        env.OPENFARM_SIM?.trim().toLowerCase() === 'docker' &&
        env.RTC_FARM_TEST_SIM_MOONRAKER &&
        env.RTC_FARM_TEST_SIM_SPOOLMAN &&
        env.RTC_FARM_TEST_SIM_PRINTING_PAUSE === 'sv06',
      )
    return true
  })
}

export function buildAcceptanceSummary(
  commit: string,
  rows: AcceptanceRow[],
): AcceptanceSummary {
  return {
    commit,
    result:
      rows.length > 0 && rows.every((row) => row.passed) ? 'passed' : 'failed',
    rows,
  }
}

export function rowPassed(
  rows: { row: string; passed: boolean }[] | undefined,
  row: string,
) {
  const attempts = rows?.filter((entry) => entry.row === row)
  return attempts?.length ? attempts.every((entry) => entry.passed) : undefined
}

export function parseLastJson(output: string): unknown {
  const starts = [...output.matchAll(/(?:^|\n)\{/g)].map(
    (match) => match.index! + match[0].lastIndexOf('{'),
  )
  for (const start of starts.reverse()) {
    let depth = 0
    let inString = false
    let escaped = false
    for (let end = start; end < output.length; end++) {
      const char = output[end]
      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') inString = true
      else if (char === '{') depth++
      else if (char === '}' && --depth === 0) {
        try {
          return JSON.parse(output.slice(start, end + 1))
        } catch {
          break
        }
      }
    }
  }
  return undefined
}

export async function runAllAcceptance(checkout: string) {
  const env = process.env
  const rows: AcceptanceRow[] = []
  const deferred: Omit<AcceptanceRow, 'passed'>[] = []
  const dockerSim = isDockerSim()
  const evidenceRoot =
    env.RTC_FARM_TEST_ALL_EVIDENCE ??
    join(homedir(), '.local/state/o3dfm/rtc-farm-all')
  const runId = `${new Date()
    .toISOString()
    .replaceAll(/[^0-9]/g, '')
    .slice(0, 14)}-${process.pid}`
  const evidence = join(evidenceRoot, runId)
  await mkdir(evidence, { recursive: true, mode: 0o700 })
  const commit = (
    await exec('git', ['rev-parse', 'HEAD'], { cwd: checkout })
  ).stdout.trim()
  const record = async (name: string, output: string, code: number) => {
    await writeFile(join(evidence, `${name}.log`), output, { mode: 0o600 })
    return code
  }
  const execute = async (
    name: string,
    command: string,
    args: string[],
    envPatch: NodeJS.ProcessEnv = {},
  ) => {
    try {
      const result = await exec(command, args, {
        cwd: checkout,
        env: { ...env, ...envPatch },
        maxBuffer: 16 * 1024 * 1024,
        timeout: 60 * 60 * 1000,
      })
      await record(name, result.stdout + result.stderr, 0)
      return { code: 0, output: result.stdout + result.stderr }
    } catch (error) {
      const failure = error as {
        code?: number
        stdout?: string
        stderr?: string
        message?: string
      }
      const output =
        (failure.stdout ?? '') +
        (failure.stderr ?? '') +
        (failure.message ?? '')
      await record(name, output, failure.code ?? 1)
      return { code: failure.code ?? 1, output }
    }
  }

  // The RTC runner shares one sealed Nitro build and PostgreSQL cluster across
  // every registered row. Explicit names include camera and simulator rows.
  const rtcRows = allAcceptanceRows(env)
  const runnableRows = runnableAcceptanceRows(env)
  const rtc = await execute(
    'rtc-farm',
    process.execPath,
    [join(checkout, 'scripts/test-rtc-farm-acceptance.ts')],
    { RTC_FARM_TEST_SCENARIOS: runnableRows.join(',') },
  )
  const rtcReport = parseLastJson(rtc.output) as
    { results?: { scenario: string; passed: boolean }[] } | undefined
  const rtcResults = rtcReport?.results?.map((entry) => ({
    row: entry.scenario,
    passed: entry.passed,
  }))
  for (const row of rtcRows) {
    if (!runnableRows.includes(row)) {
      const missing =
        row === 'farm-page-camera'
          ? 'Pinned RTSP helper and port are required'
          : row === 'farm-page-printing-pause'
            ? 'SV06 printing simulator, Moonraker and Spoolman are required'
            : 'Simulator Moonraker and Spoolman origins are required'
      if (dockerSim)
        rows.push({ suite: 'rtc-farm', row, passed: false, detail: missing })
      else deferred.push({ suite: 'rtc-farm', row, detail: missing })
      continue
    }
    const passed = rowPassed(rtcResults, row)
    rows.push({
      suite: 'rtc-farm',
      row,
      passed: passed === true,
      ...(passed === undefined
        ? { detail: 'No row result in runner output' }
        : {}),
    })
  }
  if (
    rtc.code !== 0 &&
    rtcResults?.length &&
    rtcResults.every((entry) => entry.passed)
  )
    rows.push({
      suite: 'rtc-farm',
      row: 'runner-cleanup',
      passed: false,
      detail: 'Suite exited nonzero after every selected row passed',
    })

  const flagRemoval = await execute('farmview-flag-removed', process.execPath, [
    '--test',
    'tests/node/no-farmview-flag.test.ts',
  ])
  rows.push({
    suite: 'source-contract',
    row: 'farmview-flag-removed',
    passed: flagRemoval.code === 0,
  })

  // Outage acceptance consumes the same checkout's built farm artifact. Build
  // once here so the outage runner never silently uses a stale .output tree.
  const build = await execute('farm-build', 'npm', [
    'run',
    'build',
    '-w',
    '@open3dfarmmanager/farm',
  ])
  rows.push({ suite: 'build', row: 'apps/farm', passed: build.code === 0 })
  const outage = await execute('connector-outage', process.execPath, [
    join(checkout, 'scripts/test-connector-outage-recovery.ts'),
  ])
  const outageReport = parseLastJson(outage.output) as
    | {
        result?: string
        scenarios?: { name: string; result: string }[]
      }
    | undefined
  const outageRows = outageReport?.scenarios ?? []
  if (outageRows.length)
    for (const row of outageRows)
      rows.push({
        suite: 'connector-outage',
        row: row.name,
        passed: row.result === 'passed' && outage.code === 0,
      })
  else
    rows.push({
      suite: 'connector-outage',
      row: 'suite',
      passed: outage.code === 0 && outageReport?.result === 'passed',
      detail: 'Runner did not emit scenario results',
    })

  // Each profile owns a fresh project and fully tears it down before the next.
  for (const profile of ['nat', 'netem', 'udp-block']) {
    if (!dockerSim) {
      deferred.push({
        suite: 'network-fault',
        row: profile,
        detail: 'Docker mode only (OPENFARM_SIM=docker)',
      })
      continue
    }
    const result = await execute(
      `netfault-${profile}`,
      'bash',
      [join(checkout, 'infra/sim/netfault/run.sh'), profile, '1', evidence],
      {
        NETFAULT_PROJECT: `o3dfm-accept-${profile}-${runId.slice(-6)}`,
      },
    )
    rows.push({
      suite: 'network-fault',
      row: profile,
      passed: result.code === 0,
    })
  }

  deferred.push({
    suite: 'hardware',
    row: 'E13.1-owner-hardware-acceptance',
    detail:
      'Manual physical-printer checklist in docs/HARDWARE-ACCEPTANCE-CHECKLIST.md',
  })
  const summary = buildAcceptanceSummary(commit, rows)
  const summaryPath =
    env.RTC_FARM_TEST_ALL_SUMMARY ?? join(evidence, 'summary.json')
  await writeFile(
    summaryPath,
    JSON.stringify({ ...summary, deferred, evidence, summaryPath }, null, 2) +
      '\n',
    { mode: 0o600 },
  )
  await appendFile(
    join(evidence, 'run.jsonl'),
    JSON.stringify({ summaryPath, result: summary.result }) + '\n',
    { mode: 0o600 },
  )
  process.stdout.write(
    JSON.stringify({ ...summary, deferred, evidence, summaryPath }, null, 2) +
      '\n',
  )
  return summary.result === 'passed' ? 0 : 1
}
