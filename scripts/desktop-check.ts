// SPDX-License-Identifier: MIT
// npm run desktop:check — proves OpenFarm works inside the desktop limits as a
// whole: no network beyond loopback, no Docker, system Chrome, a local
// PostgreSQL cluster and optional Go. Every Node process the steps start runs
// with the loopback network guard (scripts/desktop-network-guard.mjs); any
// blocked attempt fails the run and is listed in the summary.
//
//   node scripts/desktop-check.ts [--only a,b] [--skip a,b] [--list]
//        [--verbose] [--fail-fast] [--receipt file.json] [--log-dir dir]
//        [--require-isolated-network] [--guard-probe]
//
// Never sends a printer command. Docker stays an explicit opt-in elsewhere and
// is refused here.
import { spawn } from 'node:child_process'
import {
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { networkInterfaces, platform, release, arch, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  GUARD_LOG_ENV,
  buildHermeticEnv,
  readViolations,
  type Violation,
} from './desktop-network-env.ts'
import { preflight, type PreflightReport } from './desktop-check-preflight.ts'
import {
  GUARD_PROBE_STEP,
  STEPS,
  formatDuration,
  formatSummary,
  type StepDefinition,
  type StepResult,
} from './desktop-check-steps.ts'

const repoRoot = resolve(new URL('..', import.meta.url).pathname)

interface Options {
  only: string[] | undefined
  skip: string[]
  list: boolean
  verbose: boolean
  failFast: boolean
  receipt: string | undefined
  logDir: string | undefined
  requireIsolatedNetwork: boolean
  guardProbe: boolean
}

function csv(value: string | undefined, flag: string): string[] {
  if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`)
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

export function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    only: undefined,
    skip: [],
    list: false,
    verbose: false,
    failFast: false,
    receipt: undefined,
    logDir: undefined,
    requireIsolatedNetwork: false,
    guardProbe: false,
  }
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    const value = argv[index + 1]
    switch (flag) {
      case '--only':
        options.only = csv(value, flag)
        index++
        break
      case '--skip':
        options.skip = csv(value, flag)
        index++
        break
      case '--receipt':
        options.receipt = csv(value, flag)[0]
        index++
        break
      case '--log-dir':
        options.logDir = csv(value, flag)[0]
        index++
        break
      case '--list':
        options.list = true
        break
      case '--verbose':
        options.verbose = true
        break
      case '--fail-fast':
        options.failFast = true
        break
      case '--require-isolated-network':
        options.requireIsolatedNetwork = true
        break
      case '--guard-probe':
        options.guardProbe = true
        break
      default:
        throw new Error(`Unknown argument: ${flag}`)
    }
  }
  return options
}

/** Non-loopback interfaces that carry an address: evidence the network is not blocked. */
export function externalInterfaces(): string[] {
  return Object.entries(networkInterfaces()).flatMap(([name, addresses]) =>
    (addresses ?? [])
      // A dummy interface goes nowhere; it only gives the LAN journeys a private address.
      .filter((address) => !address.internal && !/^dummy/.test(name))
      .map((address) => `${name} ${address.address}`),
  )
}

function tail(path: string, lines = 40): string {
  try {
    return readFileSync(path, 'utf8').split('\n').slice(-lines).join('\n')
  } catch {
    return ''
  }
}

interface ChildOutcome {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly timedOut: boolean
}

let activeChild: { pid: number } | undefined

function runChild(
  step: StepDefinition,
  env: NodeJS.ProcessEnv,
  logPath: string,
  verbose: boolean,
): Promise<ChildOutcome> {
  const [program, ...args] = step.command ?? []
  return new Promise((resolveOutcome) => {
    const log = createWriteStream(logPath, { mode: 0o600 })
    const child = spawn(program!, args, {
      cwd: repoRoot,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (child.pid) activeChild = { pid: child.pid }
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killGroup(child.pid, 'SIGTERM')
      setTimeout(() => killGroup(child.pid, 'SIGKILL'), 10_000).unref()
    }, step.timeoutMs)
    const sink = (chunk: Buffer) => {
      log.write(chunk)
      if (verbose) process.stdout.write(chunk)
    }
    child.stdout.on('data', sink)
    child.stderr.on('data', sink)
    child.once('error', (error) => {
      log.write(`spawn failed: ${error.message}\n`)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      activeChild = undefined
      killGroup(child.pid, 'SIGKILL') // leftover descendants of this step
      log.end(() => resolveOutcome({ code, signal, timedOut }))
    })
  })
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return
  try {
    process.kill(-pid, signal)
  } catch {
    // Group already gone.
  }
}

function selectSteps(options: Options): StepDefinition[] {
  const catalog = options.guardProbe ? [...STEPS, GUARD_PROBE_STEP] : [...STEPS]
  const names = new Set(catalog.map((step) => step.name))
  for (const name of [...(options.only ?? []), ...options.skip])
    if (!names.has(name))
      throw new Error(`Unknown step "${name}"; known: ${[...names].join(', ')}`)
  return catalog.filter(
    (step) =>
      (!options.only || options.only.includes(step.name)) &&
      !options.skip.includes(step.name),
  )
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2))
  if (options.list) {
    for (const step of STEPS)
      console.log(`${step.name.padEnd(18)} ${step.title}`)
    return 0
  }
  const steps = selectSteps(options)
  const logRoot = options.logDir
    ? resolve(options.logDir)
    : mkdtempSync(join(tmpdir(), 'openfarm-desktop-check-'))
  mkdirSync(logRoot, { recursive: true, mode: 0o700 })
  const guardLog = join(logRoot, 'network-guard.jsonl')
  writeFileSync(guardLog, '', { mode: 0o600 })
  const shimDir = join(logRoot, 'bin')
  const baseEnv = { ...process.env }
  const childEnv = buildHermeticEnv({
    base: baseEnv,
    logPath: guardLog,
    shimDir,
  })

  // The runner is guarded too: a stray fetch here is recorded like any other.
  process.env[GUARD_LOG_ENV] = guardLog
  await import('./desktop-network-guard.mjs')

  const startedAt = new Date()
  console.log(
    `desktop:check on ${platform()} ${release()} ${arch()}, logs in ${logRoot}`,
  )
  const external = externalInterfaces()
  console.log(
    external.length === 0
      ? 'network interfaces: loopback only'
      : `network interfaces with addresses: ${external.join('; ')} (the guard still rejects non-loopback calls from Node)`,
  )

  const results: StepResult[] = []
  const violations: Array<Violation & { step: string }> = []
  const seen = { count: 0 }
  let report: PreflightReport | undefined
  let preflightFailed = false
  const outcomeOf = (name: string) =>
    results.find((result) => result.name === name)

  const collectViolations = (step: string) => {
    const all = readViolations(guardLog)
    const fresh = all.slice(seen.count)
    seen.count = all.length
    for (const violation of fresh) violations.push({ ...violation, step })
    return fresh.length
  }

  for (const step of steps) {
    const logPath = join(logRoot, `${step.name}.log`)
    const started = performance.now()
    const done = (status: StepResult['status'], reason?: string) => {
      const result: StepResult = {
        name: step.name,
        title: step.title,
        status,
        durationMs: Math.round(performance.now() - started),
        ...(reason ? { reason } : {}),
        ...(status !== 'skipped' ? { logPath } : {}),
      }
      results.push(result)
      console.log(
        `${status === 'passed' ? '✔' : status === 'failed' ? '✘' : '–'} ${step.name} (${formatDuration(result.durationMs)})${reason ? `: ${reason}` : ''}`,
      )
    }

    if (
      options.failFast &&
      results.some((result) => result.status === 'failed')
    ) {
      done('skipped', 'fail-fast after an earlier failure')
      continue
    }
    if (preflightFailed && step.name !== 'preflight') {
      done('skipped', 'preflight failed')
      continue
    }
    const blocker = (step.needs ?? [])
      .map((name) => outcomeOf(name))
      .find((result) => result && result.status !== 'passed')
    if (blocker) {
      done('skipped', `needs ${blocker.name} (${blocker.status})`)
      continue
    }
    if (step.name === 'build-rtsp-ingest' && report && !report.goAvailable) {
      done(
        'skipped',
        report.notes.find((note) =>
          note.startsWith('rtsp-ingest build skipped'),
        ) ?? 'Go not available; RTSP ingest helper is unavailable',
      )
      continue
    }

    console.log(`▶ ${step.name}: ${step.title}`)
    if (step.name === 'preflight') {
      report = preflight(baseEnv)
      const lines = [
        ...Object.entries(report.versions).map(
          ([tool, version]) => `  ${tool}: ${version}`,
        ),
        ...report.notes.map((note) => `  note: ${note}`),
        ...report.failures.map((failure) => `  FAIL: ${failure}`),
      ]
      console.log(lines.join('\n'))
      writeFileSync(logPath, lines.join('\n') + '\n', { mode: 0o600 })
      Object.assign(childEnv, report.env)
      if (options.requireIsolatedNetwork && external.length > 0)
        report = {
          ...report,
          failures: [
            ...report.failures,
            `network not isolated: ${external.join('; ')}`,
          ],
        }
      if (report.failures.length > 0) {
        preflightFailed = true
        done('failed', report.failures.join('; '))
      } else done('passed')
      collectViolations(step.name)
      continue
    }

    const outcome = await runChild(step, childEnv, logPath, options.verbose)
    const blocked = collectViolations(step.name)
    if (blocked > 0) {
      done('failed', `network guard: ${blocked} blocked attempt(s)`)
    } else if (outcome.timedOut) {
      done('failed', `timed out after ${formatDuration(step.timeoutMs)}`)
    } else if (outcome.code !== 0) {
      done('failed', `exit ${outcome.code ?? outcome.signal}`)
      console.log(tail(logPath))
    } else done('passed')
  }

  const failed = results.filter((result) => result.status === 'failed')
  const finishedAt = new Date()
  console.log(`\n${formatSummary(results)}`)
  if (violations.length > 0) {
    console.log('\nBlocked non-loopback attempts:')
    for (const violation of violations)
      console.log(
        `  [${violation.step}] ${violation.api} -> ${violation.target} (pid ${violation.pid}, ${violation.process})`,
      )
  }
  const passed = failed.length === 0 && violations.length === 0
  console.log(
    `\ndesktop:check ${passed ? 'PASSED' : 'FAILED'}${options.only ? ' (partial: --only)' : ''}: ${results.filter((r) => r.status === 'passed').length} passed, ${failed.length} failed, ${results.filter((r) => r.status === 'skipped').length} skipped in ${formatDuration(finishedAt.getTime() - startedAt.getTime())}`,
  )
  if (options.receipt) {
    writeFileSync(
      resolve(options.receipt),
      JSON.stringify(
        {
          result: passed ? 'passed' : 'failed',
          partial: Boolean(options.only),
          platform: `${platform()} ${release()} ${arch()}`,
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          versions: report?.versions ?? {},
          notes: report?.notes ?? [],
          externalInterfaces: external,
          steps: results,
          networkViolations: violations,
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    )
    console.log(`receipt: ${resolve(options.receipt)}`)
  }
  if (passed && !options.logDir)
    rmSync(logRoot, { recursive: true, force: true })
  else console.log(`logs kept in ${logRoot}`)
  return passed ? 0 : 1
}

for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    if (activeChild) killGroup(activeChild.pid, 'SIGTERM')
    process.exit(130)
  })

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(2)
  },
)
