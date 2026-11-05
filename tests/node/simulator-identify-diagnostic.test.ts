import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { gunzipSync } from 'node:zlib'

interface DiagnosticErrorShape {
  message: string
  phase: string
  cleanupErrors: { kind: string; name: string; message: string }[]
  result?: Record<string, any>
}

interface DiagnosticModule {
  OPT_IN_TOKEN: string
  PINNED_IMAGE_REFERENCE: string
  PINNED_AMD64_DIGEST: string
  PINNED_PLATFORM: string
  READINESS_BUDGET_MS: number
  OBSERVER_MOUNT_PATH: string
  OBSERVER_PREFIX: string
  CAPTURE_BYTE_LIMIT: number
  CHILD_LOG_FILE_LIMIT: number
  REPOSITORY_ROOT: string
  DiagnosticError: new (
    message: string,
    options?: { phase?: string; cause?: unknown; cleanupErrors?: unknown[] },
  ) => DiagnosticErrorShape
  parseArguments(argv: string[]): {
    optIn: string | null
    image: string
    platform: string
    observationMs: number
    composeFile: string
    observerPath: string
    ledgerDir: string | null
  }
  assertRunSettings(
    settings: {
      image: string
      platform: string
      observationMs: number
      composeFile: string
      observerPath: string
    },
    phase?: string,
  ): unknown
  parseSupervisorConfig(text: string): {
    sections: {
      type: string
      name: string
      entries: { key: string; value: string; line: number }[]
    }[]
  }
  findSupervisorServerSection(config: {
    sections: {
      type: string
      name: string
      entries: { key: string; value: string; line: number }[]
    }[]
  }): {
    type: string
    name: string
    entries: { key: string; value: string; line: number }[]
  } | null
  parseSupervisorCommand(value: string): { tokens: string[] }
  findKlipperProgram(config: {
    sections: {
      type: string
      name: string
      entries: { key: string; value: string; line: number }[]
    }[]
  }): {
    section: { entries: { key: string; value: string; line: number }[] }
    command: { key: string; value: string; line: number }
  }
  transformSupervisorConfig(
    text: string,
    options: { observerPath: string },
  ): {
    text: string
    delta: {
      interpreter: string
      klippyArguments: string[]
      klipperRoot: string
      preserved: Record<string, string>
      otherDirectivesPreserved: number
      otherPrograms: { name: string; commandDigest: string }[]
    }
  }
  resolveStderrRouting(
    section: { entries: { key: string; value: string; line: number }[] },
    serverSection?: {
      entries: { key: string; value: string; line: number }[]
    } | null,
  ): {
    kind: string
    path: string | null
    ambiguous: boolean
    candidates: { kind: string; path: string | null }[]
  }
  commandCarriesObserver(argv: string[]): boolean
  boundCapture(
    text: string,
    limit: number,
    truncated?: boolean,
  ): {
    text: string
    truncated: boolean
  }
  splitObserverRecords(text: string): { text: string; dropped: number }
  prepareAnalyzerInput(
    text: string,
    truncated?: boolean,
  ): {
    text: string
    accepted: number
    dropped: number
    reusedSession: boolean
    overflow: boolean
    notified: boolean
  }
  validateObserverAnalysis(value: unknown): {
    truncated: boolean
    sessions: Record<string, unknown>[]
  }
  readObserverSourcePins(text: string): Record<string, string>
  buildContainerArguments(options: {
    name: string
    platform: string
    image: string
    cpus: string
    memory: string
    pidsLimit: string
    labels: [string, string][]
    volume: string
    observerHostPath: string
    configHostPath: string
    configContainerPath: string
  }): string[]
  assertContainerIsolation(args: string[]): void
  canonicalPath(path: string): string
  repositoryExclusionRoots(): string[]
  assertLedgerOutsideRepository(ledgerDir: string): string
  runDiagnostic(options: RunOptions): Promise<Record<string, any>>
}

interface FakeResult {
  status: number | null
  stdout: string
  stderr: string
  timedOut?: boolean
}

interface FakeCall {
  args: string[]
  timeoutMs?: number
  input?: string
}

interface FakeDocker {
  run(
    args: string[],
    options?: { input?: string; timeoutMs?: number },
  ): Promise<FakeResult>
  calls: FakeCall[]
  transientConsumed: boolean
}

interface RunOptions {
  docker: FakeDocker
  clock?: { now: () => number }
  sleep?: (ms: number) => Promise<void>
  ledgerDir?: string
  observationMs?: number
  image?: string
  platform?: string
  composeFile?: string
  observerPath?: string
  runId: string
  runName: string
}

const moduleUrl = new URL(
  '../../scripts/simulator-identify-diagnostic.mjs',
  import.meta.url,
).href
const diagnostic = (await import(moduleUrl)) as unknown as DiagnosticModule
const OBSERVER_PREFIX = 'O3DFM_SERIAL_DIAGNOSTIC '
const OBSERVER_MAX_EVENTS = 4096

const ENTRYPOINT_SCRIPT = [
  '#!/bin/sh',
  'set -e',
  'exec /usr/local/bin/supervisord -c /usr/local/etc/supervisord.conf',
  '',
].join('\n')

const SUPERVISOR_CONFIG = [
  '[supervisord]',
  'nodaemon=true',
  'logfile=/var/log/supervisor/supervisord.log',
  '',
  '[program:klipper]',
  'command=python3 /home/printer/klipper/klippy/klippy.py',
  'autostart=true',
  'autorestart=true',
  'startsecs=10',
  'startretries=3',
  'priority=10',
  'stdout_logfile=/home/printer/printer_data/logs/klippy.log',
  'stderr_logfile=/home/printer/printer_data/logs/klippy.log',
  '',
  '[program:moonraker]',
  'command=python3 /home/printer/klipper/moonraker/moonraker.py',
  'autostart=true',
  'autorestart=true',
  '',
].join('\n')

const CHILD_LOG_CONFIG = [
  '[supervisord]',
  'nodaemon=true',
  'childlogdir=/tmp/supervisor',
  '',
  '[program:klipper]',
  'command=python3 /home/printer/klipper/klippy/klippy.py',
  'redirect_stderr=true',
  'autorestart=true',
  'startretries=3',
  '',
].join('\n')

// Exact Klipper source fixtures, compressed to keep them separate from test code.
// Copyright (C) 2016-2025 Kevin O'Connor; GPL-3.0. The decompressed
// fixtures retain the original notices. Source: https://github.com/Klipper3d/klipper
const SERIALHDL = gunzipSync(
  Buffer.from(
    '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',
    'base64',
  ),
).toString('utf8')
const SERIALQUEUE = gunzipSync(
  Buffer.from(
    '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',
    'base64',
  ),
).toString('utf8')

const OBSERVER_EVENT = (session: number, bytes: number) =>
  `${OBSERVER_PREFIX}${JSON.stringify({
    elapsed: 1.5,
    event: 'identify',
    length: 40,
    offset: bytes,
    requested: bytes,
    session,
  })}\n`
const OBSERVER_START = (session: number) =>
  `${OBSERVER_PREFIX}${JSON.stringify({
    elapsed: 0,
    event: 'start',
    session,
  })}\n`
const OBSERVER_RESULT = (session: number, success: boolean) =>
  `${OBSERVER_PREFIX}${JSON.stringify({
    event: 'result',
    session,
    success,
  })}\n`

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

// ---------------------------------------------------------------------------
// A faithful port of the existing observer analyzer. The fake must reproduce
// the observer contract, otherwise the suite proves nothing about the capture
// it feeds to the analyzer.
// ---------------------------------------------------------------------------

interface ObserverSession {
  session: number
  accepted_bytes: number
  unmatched_responses: number
  terminal_response: boolean
  counters: Record<string, number>
  finished: boolean
  success: boolean
  started: boolean
  observer_error: boolean
  last_identify_elapsed: number | null
  classification: string
}

function classifySessions(events: Record<string, unknown>[]): {
  truncated: boolean
  sessions: ObserverSession[]
} {
  const sessions = new Map<number, ObserverSession>()
  let truncated = false
  for (const event of events) {
    if (event['event'] === 'truncated') {
      truncated = true
      continue
    }
    const identity = event['session']
    if (
      typeof identity !== 'number' ||
      !Number.isInteger(identity) ||
      identity < 1
    )
      throw new Error('invalid session')
    let state = sessions.get(identity)
    if (!state) {
      state = {
        session: identity,
        accepted_bytes: 0,
        unmatched_responses: 0,
        terminal_response: false,
        counters: {},
        finished: false,
        success: false,
        started: false,
        observer_error: false,
        last_identify_elapsed: null,
        classification: '',
      }
      sessions.set(identity, state)
    }
    const kind = event['event']
    if (kind === 'identify') {
      const requested = event['requested']
      const offset = event['offset']
      const length = event['length']
      for (const value of [requested, offset, length]) {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
          throw new Error('invalid identification record')
      }
      const elapsed = event['elapsed']
      if (elapsed !== undefined && elapsed !== null) {
        if (
          typeof elapsed !== 'number' ||
          !Number.isFinite(elapsed) ||
          elapsed < 0
        )
          throw new Error('invalid identification elapsed time')
        state.last_identify_elapsed = elapsed
      }
      if (requested === offset && offset === state.accepted_bytes) {
        state.accepted_bytes += length as number
        state.terminal_response = length === 0
      } else {
        state.unmatched_responses += 1
      }
    } else if (kind === 'disconnect') {
      const counters = event['counters']
      if (
        typeof counters !== 'object' ||
        counters === null ||
        Array.isArray(counters)
      )
        throw new Error('invalid counters')
      for (const value of Object.values(counters)) {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
          throw new Error('invalid counters')
      }
      state.counters = counters as Record<string, number>
    } else if (kind === 'result') {
      if (typeof event['success'] !== 'boolean')
        throw new Error('invalid result')
      state.finished = true
      state.success = event['success']
    } else if (kind === 'start') {
      state.started = true
    } else if (kind === 'observer_error') {
      state.observer_error = true
    } else {
      throw new Error('unknown event')
    }
  }
  for (const state of sessions.values()) {
    if (truncated || !state.finished || !state.started || state.observer_error)
      state.classification = 'inconclusive-incomplete-capture'
    else if (state.success && state.terminal_response)
      state.classification = 'identification-complete-not-readiness'
    else if (state.unmatched_responses)
      state.classification = 'inconclusive-unmatched-responses'
    else if (state.terminal_response)
      state.classification = 'inconclusive-dictionary-not-loaded'
    else if (state.accepted_bytes && !state.terminal_response)
      state.classification = 'valid-incomplete-identification'
    else if (state.counters['bytes_invalid'])
      state.classification = 'inconclusive-invalid-or-sequence-rejected-traffic'
    else state.classification = 'inconclusive-no-identification-progress'
  }
  return { truncated, sessions: [...sessions.values()] }
}

function observerAnalyze(text: string): { status: number; stdout: string } {
  const events: Record<string, unknown>[] = []
  let total = 0
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    if (index === lines.length - 1 && line.length === 0) break
    const bytes = Buffer.byteLength(line, 'utf8') + 1
    total += bytes
    if (bytes > 65536 || total > 16 * 1024 * 1024)
      return { status: 78, stdout: '' }
    if (!line.startsWith(OBSERVER_PREFIX)) continue
    let item: unknown
    try {
      item = JSON.parse(line.slice(OBSERVER_PREFIX.length))
    } catch {
      return { status: 78, stdout: '' }
    }
    if (typeof item !== 'object' || item === null || Array.isArray(item))
      return { status: 78, stdout: '' }
    events.push(item as Record<string, unknown>)
    if (events.length > OBSERVER_MAX_EVENTS + 1)
      return { status: 78, stdout: '' }
  }
  try {
    return { status: 0, stdout: JSON.stringify(classifySessions(events)) }
  } catch {
    return { status: 78, stdout: '' }
  }
}

// ---------------------------------------------------------------------------
// Fake Docker
// ---------------------------------------------------------------------------

interface FakeContainer {
  labels: Record<string, string>
  volumes: string[]
}

interface FakeOptions {
  config?: string
  entrypoint?: string
  entrypointCandidates?: string[]
  capture?: string
  capturePaths?: Record<string, string>
  childLogFiles?: Record<string, string>
  labels?: Record<string, string>
  containerStatus?: string
  supervisorStatus?: string
  supervisorStatusAvailable?: boolean
  klippyArgv?: string[]
  klippyCommandReadable?: boolean
  fail?: (args: string[]) => FakeResult | null
  failOnce?: (args: string[]) => FakeResult | null
  missingFiles?: string[]
  badSource?: boolean
  timedOutCommands?: string[]
}

function createFakeDocker(options: FakeOptions = {}): FakeDocker {
  const files = new Map<string, string>([
    ['/usr/local/bin/start.sh', options.entrypoint ?? ENTRYPOINT_SCRIPT],
    ['/usr/local/etc/supervisord.conf', options.config ?? SUPERVISOR_CONFIG],
    [
      '/home/printer/klipper/klippy/serialhdl.py',
      options.badSource ? 'wrong source' : SERIALHDL,
    ],
    ['/home/printer/klipper/klippy/chelper/serialqueue.c', SERIALQUEUE],
  ])
  for (const missing of options.missingFiles ?? []) files.delete(missing)
  const labels = options.labels ?? {
    'com.open3dfarmmanager.identify-diagnostic': 'run-1',
  }
  const containers = new Map<string, FakeContainer>()
  const volumes = new Map<string, Record<string, string>>()
  const childLogFiles = options.childLogFiles ?? {}
  const fake: FakeDocker = {
    calls: [],
    transientConsumed: false,
    async run(
      args: string[],
      runOptions?: { input?: string; timeoutMs?: number },
    ): Promise<FakeResult> {
      fake.calls.push({
        args,
        ...(runOptions?.timeoutMs === undefined
          ? {}
          : { timeoutMs: runOptions.timeoutMs }),
        ...(runOptions?.input === undefined ? {} : { input: runOptions.input }),
      })
      for (const command of options.timedOutCommands ?? []) {
        if (args[0] === command)
          return {
            status: null,
            stdout: '',
            stderr: 'docker call exceeded its time limit',
            timedOut: true,
          }
      }
      const failure = options.fail?.(args)
      if (failure) return failure
      if (!fake.transientConsumed) {
        const transient = options.failOnce?.(args)
        if (transient) {
          fake.transientConsumed = true
          return transient
        }
      }
      const [command, ...rest] = args
      if (command === 'create') {
        const name = rest[rest.indexOf('--name') + 1] ?? 'unnamed'
        const mounted: string[] = []
        for (let index = 0; index < rest.length; index++) {
          if (rest[index] !== '--volume') continue
          const source = (rest[index + 1] ?? '').split(':')[0] ?? ''
          if (source && !source.includes('/')) mounted.push(source)
        }
        containers.set(name, { labels: { ...labels }, volumes: mounted })
        return { status: 0, stdout: 'container-id\n', stderr: '' }
      }
      if (command === 'start') return { status: 0, stdout: '', stderr: '' }
      if (command === 'cp') {
        const source = rest[0] ?? ''
        const separator = source.indexOf(':')
        const path = source.slice(separator + 1)
        const content = files.get(path)
        if (content === undefined)
          return { status: 1, stdout: '', stderr: 'no such file' }
        writeFileSync(rest[1] ?? '', content)
        return { status: 0, stdout: '', stderr: '' }
      }
      if (command === 'inspect') {
        if (rest[0] === '--format') {
          const format = rest[1] ?? ''
          if (format.includes('.Config.Labels')) {
            const target = rest[2] ?? ''
            const container = containers.get(target)
            return {
              status: container ? 0 : 1,
              stdout: JSON.stringify(container?.labels ?? {}),
              stderr: container ? '' : 'no such container',
            }
          }
          if (format.includes('.State.Status'))
            return {
              status: 0,
              stdout: `${options.containerStatus ?? 'running'}\n`,
              stderr: '',
            }
          if (format.includes('.State'))
            return {
              status: 0,
              stdout: JSON.stringify({
                Status: options.containerStatus ?? 'running',
                ExitCode: 0,
                OOMKilled: false,
              }),
              stderr: '',
            }
        }
        const candidates = options.entrypointCandidates ?? [
          '/usr/local/bin/start.sh',
        ]
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              Config: { Entrypoint: candidates, Cmd: [] },
            },
          ]),
          stderr: '',
        }
      }
      if (command === 'volume') {
        const sub = rest[0]
        if (sub === 'create') {
          const name = rest[rest.length - 1] ?? 'volume'
          volumes.set(name, { ...labels })
          return { status: 0, stdout: 'volume-name\n', stderr: '' }
        }
        if (sub === 'inspect') {
          const name = rest[rest.length - 1] ?? ''
          const volume = volumes.get(name)
          return {
            status: volume ? 0 : 1,
            stdout: JSON.stringify(volume ?? {}),
            stderr: volume ? '' : 'no such volume',
          }
        }
        if (sub === 'rm') {
          const name = rest[rest.length - 1] ?? ''
          for (const [containerName, container] of containers) {
            if (container.volumes.includes(name))
              return {
                status: 1,
                stdout: '',
                stderr: `Error response from daemon: volume ${name} is in use by container ${containerName}`,
              }
          }
          volumes.delete(name)
          return { status: 0, stdout: '', stderr: '' }
        }
        return { status: 0, stdout: '', stderr: '' }
      }
      if (command === 'rm') {
        containers.delete(rest[1] ?? '')
        return { status: 0, stdout: '', stderr: '' }
      }
      if (command === 'logs') {
        const lines = (options.capture ?? '').split('\n')
        if (lines.at(-1) === '') lines.pop()
        const limit = Number(rest[rest.indexOf('--tail') + 1])
        return {
          status: 0,
          stdout: lines
            .slice(-limit)
            .map((line) => line + '\n')
            .join(''),
          stderr: '',
        }
      }
      if (command === 'exec') {
        const execArgv = rest[0] === '-i' ? rest.slice(1) : rest
        const target = execArgv[1] ?? ''
        if (target === 'supervisorctl') {
          if (options.supervisorStatusAvailable === false)
            return {
              status: 1,
              stdout: '',
              stderr: 'unix:///var/run/supervisor.sock no such file',
            }
          return {
            status: 0,
            stdout:
              options.supervisorStatus ??
              'klipper RUNNING pid 42\nmoonraker RUNNING pid 43\nsimulavr RUNNING pid 44\nwebcamd RUNNING pid 45\n',
            stderr: '',
          }
        }
        if (target === 'cat' && (execArgv[2] ?? '').startsWith('/proc/')) {
          if (options.klippyCommandReadable === false)
            return { status: 1, stdout: '', stderr: 'no such process' }
          return {
            status: 0,
            stdout: (
              options.klippyArgv ?? [
                'python3',
                diagnostic.OBSERVER_MOUNT_PATH,
                'observe',
                '/home/printer/klipper',
                '--',
              ]
            ).join('\0'),
            stderr: '',
          }
        }
        if (target === 'python3' && execArgv[2] === '-c') {
          return { status: 0, stdout: '/tmp\n', stderr: '' }
        }
        if (target === 'ls') {
          const directory = execArgv[execArgv.length - 1] ?? ''
          const names = Object.keys(childLogFiles)
            .filter((path) => path.startsWith(`${directory}/`))
            .map((path) => path.slice(directory.length + 1))
          if (names.length === 0)
            return {
              status: 1,
              stdout: '',
              stderr: `ls: cannot open directory '${directory}'`,
            }
          return { status: 0, stdout: `${names.join('\n')}\n`, stderr: '' }
        }
        if (target === 'tail') {
          const path = execArgv[execArgv.length - 1] ?? ''
          const content =
            childLogFiles[path] ??
            options.capturePaths?.[path] ??
            options.capture
          if (content === undefined)
            return { status: 1, stdout: '', stderr: 'no such file' }
          const limit = Number(execArgv[execArgv.length - 2] ?? '0')
          const bytes = Buffer.from(content, 'utf8')
          const slice =
            limit > 0 && bytes.length > limit
              ? bytes.subarray(bytes.length - limit)
              : bytes
          return { status: 0, stdout: slice.toString('utf8'), stderr: '' }
        }
        if (target === 'python3') {
          const analysis = observerAnalyze(runOptions?.input ?? '')
          return {
            status: analysis.status,
            stdout: analysis.stdout,
            stderr: analysis.status === 0 ? '' : 'SIM_SERIAL_DIAGNOSTIC_FAILED',
          }
        }
        return { status: 0, stdout: '', stderr: '' }
      }
      return { status: 0, stdout: '', stderr: '' }
    },
  }
  return fake
}

function createLedger(): string {
  return mkdtempSync(join(tmpdir(), 'open3dfm-identify-ledger-'))
}

function createClock(): {
  clock: { now: () => number }
  sleep: (ms: number) => Promise<void>
} {
  let current = 1_000_000
  return {
    clock: { now: () => current },
    sleep: async (ms: number) => {
      current += ms
    },
  }
}

function runOptions(
  docker: FakeDocker,
  overrides: Partial<RunOptions> = {},
): RunOptions {
  const ledger = overrides.ledgerDir ?? createLedger()
  const { clock, sleep } = createClock()
  return {
    docker,
    clock,
    sleep,
    ledgerDir: ledger,
    runId: 'run-1',
    runName: 'open3dfm-identify-run-1',
    observationMs: 5_000,
    ...overrides,
  }
}

function cleanupLedger(ledger: string): void {
  rmSync(ledger, { recursive: true, force: true })
}

function removalCalls(docker: FakeDocker): string[][] {
  return docker.calls
    .map((call) => call.args)
    .filter(
      (args) => args[0] === 'rm' || (args[0] === 'volume' && args[1] === 'rm'),
    )
}

// ---------------------------------------------------------------------------
// Command line and settings
// ---------------------------------------------------------------------------

test('rejects a missing or wrong synthetic opt-in', () => {
  assert.throws(
    () => diagnostic.parseArguments([]),
    (error: DiagnosticErrorShape) =>
      error.message.includes('opt-in') && error.phase === 'arguments',
  )
  assert.throws(
    () => diagnostic.parseArguments(['--opt-in=synthetic']),
    (error: DiagnosticErrorShape) => error.message.includes('opt-in'),
  )
})

test('rejects endpoint arguments, foreign images and an extended deadline', () => {
  const optIn = `--opt-in=${diagnostic.OPT_IN_TOKEN}`
  assert.throws(
    () => diagnostic.parseArguments([optIn, '--host=127.0.0.1']),
    (error: DiagnosticErrorShape) => error.message.includes('endpoint'),
  )
  assert.throws(
    () => diagnostic.parseArguments([optIn, '--url=http://127.0.0.1:7125']),
    (error: DiagnosticErrorShape) => error.message.includes('endpoint'),
  )
  assert.throws(
    () => diagnostic.parseArguments([optIn, '--image=alpine:latest']),
    (error: DiagnosticErrorShape) => error.message.includes('pinned'),
  )
  assert.throws(
    () => diagnostic.parseArguments([optIn, '--observation-ms=120000']),
    (error: DiagnosticErrorShape) => error.message.includes('90 second'),
  )
  const options = diagnostic.parseArguments([optIn, '--observation-ms=90000'])
  assert.equal(options.observationMs, diagnostic.READINESS_BUDGET_MS)
  assert.equal(options.image, diagnostic.PINNED_IMAGE_REFERENCE)
})

test('the programmatic entry point refuses an unpinned image or an extended window', async () => {
  const docker = createFakeDocker()
  const options = runOptions(docker, { image: 'alpine:latest' })
  const ledger = options.ledgerDir as string
  try {
    await assert.rejects(
      () => diagnostic.runDiagnostic(options),
      (error: DiagnosticErrorShape) =>
        error.message.includes('pinned') && error.phase === 'settings',
    )
    await assert.rejects(
      () =>
        diagnostic.runDiagnostic(
          runOptions(docker, {
            ledgerDir: ledger,
            observationMs: diagnostic.READINESS_BUDGET_MS + 1,
          }),
        ),
      (error: DiagnosticErrorShape) =>
        error.message.includes('90 second') && error.phase === 'settings',
    )
    assert.equal(
      docker.calls.length,
      0,
      'no docker call happens before the settings are accepted',
    )
  } finally {
    cleanupLedger(ledger)
  }
})

test('the runner refuses to start without the explicit opt-in', () => {
  const dir = mkdtempSync(join(tmpdir(), 'open3dfm-identify-cli-'))
  try {
    const marker = join(dir, 'docker-called')
    writeFileSync(
      join(dir, 'docker'),
      `#!/bin/sh\nprintf 'called' > '${marker}'\nexit 0\n`,
      { mode: 0o700 },
    )
    const script = new URL(
      '../../scripts/simulator-identify-diagnostic.mjs',
      import.meta.url,
    ).pathname
    const run = spawnSync(process.execPath, [script, '--image=alpine:latest'], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      encoding: 'utf8',
      timeout: 10_000,
    })
    assert.equal(run.status, 2)
    assert.match(run.stderr, /opt-in/)
    assert.equal(
      (() => {
        try {
          readFileSync(marker)
          return true
        } catch {
          return false
        }
      })(),
      false,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Configuration parsing and transformation
// ---------------------------------------------------------------------------

test('parses the pinned supervisor configuration and finds one klippy command', () => {
  const config = diagnostic.parseSupervisorConfig(SUPERVISOR_CONFIG)
  const program = diagnostic.findKlipperProgram(config)
  assert.equal(
    program.command.value,
    'python3 /home/printer/klipper/klippy/klippy.py',
  )
  const duplicated = SUPERVISOR_CONFIG.replace(
    '[program:moonraker]',
    '[program:klipper]\ncommand=python3 /home/printer/klipper/klippy/klippy.py\n\n[program:moonraker]',
  )
  assert.throws(
    () =>
      diagnostic.findKlipperProgram(
        diagnostic.parseSupervisorConfig(duplicated),
      ),
    (error: DiagnosticErrorShape) => error.message.includes('exactly one'),
  )
})

test('rejects shell metacharacters in a supervisor command', () => {
  assert.throws(
    () =>
      diagnostic.parseSupervisorCommand(
        'python3 /home/printer/klipper/klippy/klippy.py; rm -rf /',
      ),
    (error: DiagnosticErrorShape) => error.message.includes('metacharacter'),
  )
  assert.throws(
    () =>
      diagnostic.parseSupervisorCommand(
        'python3 /home/printer/klipper/klippy/klippy.py $(id)',
      ),
    (error: DiagnosticErrorShape) => error.message.includes('metacharacter'),
  )
  assert.deepEqual(
    diagnostic.parseSupervisorCommand('python3 -u "/opt/klippy.py"').tokens,
    ['python3', '-u', '/opt/klippy.py'],
  )
  assert.throws(
    () => diagnostic.parseSupervisorCommand('python3 "/opt/a b/klippy.py"'),
    (error: DiagnosticErrorShape) => error.message.includes('whitespace'),
  )
})

test('rewrites only the klippy command and preserves policy and other programs', () => {
  const transformed = diagnostic.transformSupervisorConfig(SUPERVISOR_CONFIG, {
    observerPath: diagnostic.OBSERVER_MOUNT_PATH,
  })
  const lines = transformed.text.split('\n')
  const klipperCommand = lines.find((line) => line.startsWith('command='))
  assert.equal(
    klipperCommand,
    `command=python3 ${diagnostic.OBSERVER_MOUNT_PATH} observe /home/printer/klipper --`,
  )
  assert.equal(
    lines.filter((line) => line.startsWith('command=')).length,
    2,
    'the moonraker command must stay untouched',
  )
  assert.ok(lines.includes('autorestart=true'))
  assert.ok(lines.includes('startretries=3'))
  assert.ok(
    lines.includes('stdout_logfile=/home/printer/printer_data/logs/klippy.log'),
  )
  assert.equal(transformed.delta.klipperRoot, '/home/printer/klipper')
  assert.deepEqual(transformed.delta.klippyArguments, [])
  assert.equal(transformed.delta.preserved.autorestart, 'true')
  assert.equal(transformed.delta.preserved.startretries, '3')
  assert.equal(transformed.delta.otherPrograms.length, 1)
  assert.equal(transformed.delta.otherPrograms[0]?.name, 'moonraker')
})

test('keeps the interpreter and the klippy arguments of the pinned command', () => {
  const source = SUPERVISOR_CONFIG.replace(
    'command=python3 /home/printer/klipper/klippy/klippy.py',
    'command=/usr/bin/python3 -u /home/printer/klipper/klippy/klippy.py -I',
  )
  const transformed = diagnostic.transformSupervisorConfig(source, {
    observerPath: diagnostic.OBSERVER_MOUNT_PATH,
  })
  assert.equal(
    transformed.text.split('\n').find((line) => line.startsWith('command=')),
    `command=/usr/bin/python3 -u ${diagnostic.OBSERVER_MOUNT_PATH} observe /home/printer/klipper -- -I`,
  )
  assert.deepEqual(transformed.delta.klippyArguments, ['-I'])
})

test('refuses a multi-line klippy command instead of guessing', () => {
  const source = SUPERVISOR_CONFIG.replace(
    'command=python3 /home/printer/klipper/klippy/klippy.py',
    'command=python3 /home/printer/klipper/klippy/klippy.py\n    --extra',
  )
  assert.throws(
    () =>
      diagnostic.transformSupervisorConfig(source, {
        observerPath: diagnostic.OBSERVER_MOUNT_PATH,
      }),
    (error: DiagnosticErrorShape) => error.message.includes('multi-line'),
  )
})

// ---------------------------------------------------------------------------
// Stderr routing
// ---------------------------------------------------------------------------

test('resolves the child stderr routing from the extracted configuration', () => {
  const config = diagnostic.parseSupervisorConfig(SUPERVISOR_CONFIG)
  const program = diagnostic.findKlipperProgram(config).section
  const routing = diagnostic.resolveStderrRouting(program)
  assert.equal(routing.kind, 'stdout-file')
  assert.equal(routing.path, '/home/printer/printer_data/logs/klippy.log')
  assert.equal(
    routing.ambiguous,
    true,
    'an absent redirect_stderr keeps both branches possible',
  )

  const separated = SUPERVISOR_CONFIG.replace(
    'stdout_logfile=/home/printer/printer_data/logs/klippy.log',
    'redirect_stderr=false',
  )
  const separatedProgram = diagnostic.findKlipperProgram(
    diagnostic.parseSupervisorConfig(separated),
  ).section
  const separatedRouting = diagnostic.resolveStderrRouting(separatedProgram)
  assert.equal(separatedRouting.kind, 'stderr-file')
  assert.equal(
    separatedRouting.path,
    '/home/printer/printer_data/logs/klippy.log',
  )
})

test('routes a redirected child to the supervisor child log without aborting', () => {
  const config = diagnostic.parseSupervisorConfig(CHILD_LOG_CONFIG)
  const program = diagnostic.findKlipperProgram(config).section
  const server = diagnostic.findSupervisorServerSection(config)
  const routing = diagnostic.resolveStderrRouting(program, server)
  assert.equal(routing.kind, 'child-log')
  assert.equal(routing.path, null)
  assert.equal(routing.ambiguous, false)
  assert.equal(routing.candidates.length, 1)
  assert.equal(routing.candidates[0]?.kind, 'child-log')
})

test('keeps both routes possible when redirect_stderr is absent', () => {
  const withoutRouting = SUPERVISOR_CONFIG.replace(
    'stdout_logfile=/home/printer/printer_data/logs/klippy.log\n',
    '',
  ).replace('stderr_logfile=/home/printer/printer_data/logs/klippy.log\n', '')
  const config = diagnostic.parseSupervisorConfig(withoutRouting)
  const program = diagnostic.findKlipperProgram(config).section
  const routing = diagnostic.resolveStderrRouting(program)
  assert.equal(routing.ambiguous, true)
  assert.deepEqual(
    routing.candidates.map((candidate) => candidate.kind),
    ['child-log', 'container-output'],
  )
})

test('reports an unusable routing as unresolved instead of aborting', () => {
  const relative = SUPERVISOR_CONFIG.replace(
    'stderr_logfile=/home/printer/printer_data/logs/klippy.log',
    'stderr_logfile=klippy.log\nredirect_stderr=false',
  )
  const config = diagnostic.parseSupervisorConfig(relative)
  const program = diagnostic.findKlipperProgram(config).section
  const routing = diagnostic.resolveStderrRouting(program)
  assert.equal(routing.kind, 'unresolved')
  assert.equal(routing.candidates.length, 0)
})

test('detects the observer wrapper in the process command line', () => {
  assert.equal(
    diagnostic.commandCarriesObserver([
      'python3',
      diagnostic.OBSERVER_MOUNT_PATH,
      'observe',
      '/home/printer/klipper',
      '--',
    ]),
    true,
  )
  assert.equal(
    diagnostic.commandCarriesObserver([
      'python3',
      '/home/printer/klipper/klippy/klippy.py',
    ]),
    false,
  )
  assert.equal(
    diagnostic.commandCarriesObserver([
      'python3',
      diagnostic.OBSERVER_MOUNT_PATH,
      'analyze',
    ]),
    false,
  )
})

// ---------------------------------------------------------------------------
// Observer data validation
// ---------------------------------------------------------------------------

test('validates observer data and drops fields the observer did not produce', () => {
  const validated = diagnostic.validateObserverAnalysis({
    truncated: false,
    sessions: [
      {
        session: 1,
        accepted_bytes: 680,
        unmatched_responses: 0,
        terminal_response: false,
        counters: { bytes_read: 680, bytes_invalid: 0 },
        finished: false,
        success: false,
        started: true,
        observer_error: false,
        last_identify_elapsed: 3.33,
        classification: 'valid-incomplete-identification',
        secret: 'SECRET_MARKER',
      },
    ],
  })
  assert.equal(validated.sessions.length, 1)
  assert.equal('secret' in (validated.sessions[0] ?? {}), false)
  assert.throws(
    () =>
      diagnostic.validateObserverAnalysis({
        truncated: false,
        sessions: [
          {
            session: 1,
            accepted_bytes: 0,
            unmatched_responses: 0,
            terminal_response: false,
            counters: {},
            finished: false,
            success: false,
            started: false,
            observer_error: false,
            last_identify_elapsed: null,
            classification: 'ready',
          },
        ],
      }),
    (error: DiagnosticErrorShape) => error.message.includes('classification'),
  )
  assert.throws(
    () =>
      diagnostic.validateObserverAnalysis({
        truncated: false,
        sessions: [
          {
            session: 1,
            accepted_bytes: 0,
            unmatched_responses: 0,
            terminal_response: false,
            counters: {},
            finished: false,
            success: false,
            started: false,
            observer_error: false,
            last_identify_elapsed: Number.POSITIVE_INFINITY,
            classification: 'inconclusive-no-identification-progress',
          },
        ],
      }),
    (error: DiagnosticErrorShape) => error.message.includes('elapsed'),
  )
})

test('reads exactly two klippy source pins from the pinned observer bytes', () => {
  const observerSource = readFileSync(
    new URL(
      '../../infra/sim/experiments/serial_diagnostic.py',
      import.meta.url,
    ),
    'utf8',
  )
  const pins = diagnostic.readObserverSourcePins(observerSource)
  assert.deepEqual(Object.keys(pins).sort(), [
    'klippy/chelper/serialqueue.c',
    'klippy/serialhdl.py',
  ])
  for (const value of Object.values(pins)) assert.match(value, /^[0-9a-f]{64}$/)
})

// ---------------------------------------------------------------------------
// Container isolation
// ---------------------------------------------------------------------------

test('builds an isolated container specification without published ports', () => {
  const args = diagnostic.buildContainerArguments({
    name: 'open3dfm-identify-run-1',
    platform: 'linux/amd64',
    image: diagnostic.PINNED_IMAGE_REFERENCE,
    cpus: '2.0',
    memory: '1g',
    pidsLimit: '256',
    labels: [['com.open3dfarmmanager.identify-diagnostic', 'run-1']],
    volume: 'open3dfm-identify-run-1-data',
    observerHostPath: '/repo/infra/sim/experiments/serial_diagnostic.py',
    configHostPath: '/tmp/work/supervisord.conf',
    configContainerPath: '/usr/local/etc/supervisord.conf',
  })
  diagnostic.assertContainerIsolation(args)
  assert.ok(args.includes('--network'))
  assert.equal(args[args.indexOf('--network') + 1], 'none')
  assert.equal(args[args.indexOf('--pull') + 1], 'never')
  assert.equal(args[args.indexOf('--cpus') + 1], '2.0')
  assert.equal(args[args.indexOf('--memory') + 1], '1g')
  assert.equal(args[args.indexOf('--pids-limit') + 1], '256')
  assert.equal(
    args.some((argument) => argument === '--privileged'),
    false,
  )
  assert.equal(
    args.some((argument) => argument === '-p'),
    false,
  )
  assert.equal(
    args.some((argument) => argument.endsWith(':ro')),
    true,
    'the observer and the configuration are mounted read-only',
  )
  for (const forbidden of [
    '--privileged',
    '--privileged=true',
    '--device=/dev/sda',
    '--publish=8080:80',
    '--cap-add=ALL',
    '--pid=host',
    '--ipc=host',
    '--userns=host',
    '--security-opt=seccomp=unconfined',
  ]) {
    assert.throws(
      () => diagnostic.assertContainerIsolation([...args, forbidden]),
      (error: DiagnosticErrorShape) => error.message.includes('forbidden'),
      `${forbidden} must be refused`,
    )
  }
  assert.throws(
    () =>
      diagnostic.assertContainerIsolation([
        ...args.filter((argument) => !argument.endsWith(':ro')),
      ]),
    (error: DiagnosticErrorShape) => error.message.includes('writable'),
  )
})

// ---------------------------------------------------------------------------
// End to end runs against the fake Docker seam
// ---------------------------------------------------------------------------

test('collects a bounded observation and reports no readiness acceptance', async () => {
  const records =
    OBSERVER_START(1) +
    OBSERVER_EVENT(1, 0) +
    OBSERVER_EVENT(1, 40) +
    OBSERVER_RESULT(1, false)
  const docker = createFakeDocker({
    capture: records,
    capturePaths: {
      '/home/printer/printer_data/logs/klippy.log': records,
    },
  })
  const options = runOptions(docker)
  const ledger = options.ledgerDir as string
  try {
    const result = await diagnostic.runDiagnostic(options)
    assert.equal(result.readiness, 'not-evaluated')
    assert.equal(result.wrapperApplied, true)
    assert.equal(result.wrapperReason, 'observer-in-command')
    assert.equal(result.supervisorObservation, 'observed')
    assert.equal(result.observerAnalysis.sessions.length, 1)
    assert.equal(
      result.observerAnalysis.sessions[0].classification,
      'valid-incomplete-identification',
    )
    assert.equal(result.capture.observerRecords, 4)
    assert.equal(result.capture.reason, 'observer-records-captured')
    assert.equal(result.capture.source, 'stdout-file')
    assert.equal(result.routing.kind, 'stdout-file')
    assert.equal(result.routing.evidence, 'observer-records')
    assert.equal(result.pin.imageDigest, diagnostic.PINNED_AMD64_DIGEST)
    assert.deepEqual(result.processes, {
      klipper: 'RUNNING',
      moonraker: 'RUNNING',
      simulavr: 'RUNNING',
      webcamd: 'RUNNING',
    })
    assert.equal(result.observation.exceededBudget, false)
    assert.equal(result.observation.observedMs, 5_000)
    assert.equal(result.container.isolation.network, 'none')
    assert.equal(result.container.isolation.publishedPorts, 0)
    assert.equal(result.cleanup.completed, true)
    assert.equal(result.totalElapsedMs >= 5_000, true)
    assert.equal(typeof result.stages.observe, 'number')
    const starts = docker.calls.filter((call) => call.args[0] === 'start')
    assert.equal(starts.length, 1, 'the run is never repeated')
    const creates = docker.calls.filter((call) => call.args[0] === 'create')
    assert.equal(
      creates.length,
      2,
      'one inspection container and one run container',
    )
    for (const call of creates) assert.equal(call.args.includes('--pull'), true)
  } finally {
    cleanupLedger(ledger)
  }
})

test('removes the container before the volume it mounts', async () => {
  const docker = createFakeDocker({
    capture: OBSERVER_START(1),
    capturePaths: {
      '/home/printer/printer_data/logs/klippy.log': OBSERVER_START(1),
    },
  })
  const options = runOptions(docker)
  const ledger = options.ledgerDir as string
  try {
    const result = await diagnostic.runDiagnostic(options)
    assert.equal(result.cleanup.completed, true)
    assert.deepEqual(result.cleanup.errors, [])
    const removals = removalCalls(docker)
    assert.equal(removals.length, 3)
    const containerIndex = removals.findIndex(
      (args) => args[0] === 'rm' && args.includes('open3dfm-identify-run-1'),
    )
    const volumeIndex = removals.findIndex(
      (args) => args[0] === 'volume' && args[1] === 'rm',
    )
    assert.equal(containerIndex >= 0, true)
    assert.equal(volumeIndex >= 0, true)
    assert.equal(
      containerIndex < volumeIndex,
      true,
      'a volume cannot be removed while a container still mounts it',
    )
    const inspectionIndex = removals.findIndex(
      (args) =>
        args[0] === 'rm' && args.includes('open3dfm-identify-run-1-inspect'),
    )
    assert.equal(inspectionIndex < volumeIndex, true)
  } finally {
    cleanupLedger(ledger)
  }
})

test('keeps raw configuration and captured logs out of the report', async () => {
  const docker = createFakeDocker({
    config: SUPERVISOR_CONFIG.replace(
      '[supervisord]',
      '[supervisord]\nenvironment=SECRET_MARKER,TOKEN=abc',
    ),
    capture: `SECRET_MARKER ${OBSERVER_EVENT(1, 0)}`,
    capturePaths: {
      '/home/printer/printer_data/logs/klippy.log': `SECRET_MARKER ${OBSERVER_EVENT(1, 0)}`,
    },
  })
  const options = runOptions(docker)
  const ledger = options.ledgerDir as string
  try {
    const result = await diagnostic.runDiagnostic(options)
    const serialized = JSON.stringify(result)
    assert.equal(serialized.includes('SECRET_MARKER'), false)
    assert.equal(serialized.includes('TOKEN=abc'), false)
    assert.equal(serialized.includes('klippy.log'), false)
    const retained = readFileSync(join(ledger, 'child-stderr.log'), 'utf8')
    assert.ok(retained.includes('SECRET_MARKER'))
  } finally {
    cleanupLedger(ledger)
  }
})

test('bounds the captured stderr and records the truncation', async () => {
  const oversized = `${OBSERVER_PREFIX}{}\n`.repeat(
    Math.ceil(diagnostic.CAPTURE_BYTE_LIMIT / 24) + 10,
  )
  const docker = createFakeDocker({
    capture: oversized,
    capturePaths: {
      '/home/printer/printer_data/logs/klippy.log': oversized,
    },
  })
  const options = runOptions(docker)
  const ledger = options.ledgerDir as string
  try {
    const result = await diagnostic.runDiagnostic(options)
    assert.equal(
      result.capture.bytes <= diagnostic.CAPTURE_BYTE_LIMIT,
      true,
      'the capture never exceeds the limit',
    )
    assert.equal(result.capture.truncated, true)
    assert.equal(result.capture.limitBytes, diagnostic.CAPTURE_BYTE_LIMIT)
  } finally {
    cleanupLedger(ledger)
  }
})

test('keeps the analysis when the captured stream holds a record that was cut in half', async () => {
  const records =
    OBSERVER_START(1) + OBSERVER_EVENT(1, 0) + OBSERVER_RESULT(1, false)
  const partial = `${OBSERVER_PREFIX}{"elapsed":0,"event":"start","sess`
  // One half written record inside the stream and one at its end.
  const raw =
    OBSERVER_START(1) +
    partial +
    '\n' +
    OBSERVER_EVENT(1, 0) +
    OBSERVER_RESULT(1, false) +
    partial
  assert.equal(
    observerAnalyze(raw).status,
    78,
    'the observer aborts on a record that was cut in half',
  )
  const docker = createFakeDocker({
    capture: raw,
    capturePaths: {
      '/home/printer/printer_data/logs/klippy.log': raw,
    },
  })
  const options = runOptions(docker)
  const ledger = options.ledgerDir as string
  try {
    const result = await diagnostic.runDiagnostic(options)
    assert.equal(
      result.observerAnalysisError,
      null,
      'a half written record must not lose the analysis',
    )
    assert.ok(result.observerAnalysis)
    assert.equal(result.observerAnalysis.sessions.length, 1)
    assert.equal(result.observerAnalysis.sessions[0].session, 1)
    assert.equal(
      result.observerAnalysis.sessions[0].classification,
      'inconclusive-incomplete-capture',
    )
    assert.equal(result.capture.observerRecords, 3)
    assert.equal(
      result.capture.invalidRecords,
      1,
      'the record that was cut in half is reported, not hidden',
    )
  } finally {
    cleanupLedger(ledger)
  }
})

test('the fake analyzer reproduces the observer output for the same records', () => {
  const records =
    OBSERVER_START(1) + OBSERVER_EVENT(1, 0) + OBSERVER_RESULT(1, false)
  const analysis = observerAnalyze(records)
  assert.equal(analysis.status, 0)
  // The expected value is the output of the unchanged observer for the same
  // records, checked offline with the existing analyzer.
  assert.deepEqual(JSON.parse(analysis.stdout), {
    truncated: false,
    sessions: [
      {
        session: 1,
        accepted_bytes: 40,
        unmatched_responses: 0,
        terminal_response: false,
        counters: {},
        finished: true,
        success: false,
        started: true,
        observer_error: false,
        last_identify_elapsed: 1.5,
        classification: 'valid-incomplete-identification',
      },
    ],
  })
})

test('drops the observer records that were cut in half', () => {
  const records =
    OBSERVER_START(1) + OBSERVER_EVENT(1, 0) + OBSERVER_RESULT(1, false)
  const partial = `${OBSERVER_PREFIX}{"elapsed":0,"event":"start","sess`
  const split = diagnostic.splitObserverRecords(records + partial)
  assert.equal(split.dropped, 1)
  assert.equal(
    observerAnalyze(split.text).status,
    0,
    'the analyzer receives whole records only',
  )
  assert.equal(
    observerAnalyze(records + partial).status,
    78,
    'the raw capture would lose the whole analysis',
  )
  const untouched = diagnostic.splitObserverRecords(records)
  assert.equal(untouched.dropped, 0)
  assert.equal(untouched.text, records)
})

test('the observer analyzer rejects a record that was cut in half', () => {
  const fragment = `${OBSERVER_PREFIX}{"elapsed":0,"event":"st`
  const analysis = observerAnalyze(fragment + '\n')
  assert.equal(
    analysis.status,
    78,
    'the real observer aborts on a malformed observer record',
  )
})

test('stops before the observation when the configuration does not match', async () => {
  const duplicated = SUPERVISOR_CONFIG.replace(
    '[program:moonraker]',
    '[program:klipper]\ncommand=python3 /home/printer/klipper/klippy/klippy.py\n\n[program:moonraker]',
  )
  const docker = createFakeDocker({ config: duplicated })
  const options = runOptions(docker)
  const ledger = options.ledgerDir as string
  try {
    await assert.rejects(
      () => diagnostic.runDiagnostic(options),
      (error: DiagnosticErrorShape) =>
        error.message.includes('exactly one') && error.phase === 'parse',
    )
    assert.equal(
      docker.calls.filter((call) => call.args[0] === 'start').length,
      0,
      'no diagnostic container is started when the configuration does not match',
    )
  } finally {
    cleanupLedger(ledger)
  }
})

test('stops before the observation when a klipper source hash does not match', async () => {
  const docker = createFakeDocker({ badSource: true })
  const options = runOptions(docker)
  const ledger = options.ledgerDir as string
  try {
    await assert.rejects(
      () => diagnostic.runDiagnostic(options),
      (error: DiagnosticErrorShape) =>
        error.message.includes('reviewed hash') && error.phase === 'discover',
    )
    assert.equal(
      docker.calls.filter((call) => call.args[0] === 'start').length,
      0,
    )
  } finally {
    cleanupLedger(ledger)
  }
})

test('skips an entrypoint candidate that is not a script', async () => {
  const docker = createFakeDocker({
    entrypointCandidates: ['/bin/sh', '/usr/local/bin/start.sh'],
    missingFiles: ['/bin/sh'],
  })
  const options = runOptions(docker)
  const ledger = options.ledgerDir as string
  try {
    const result = await diagnostic.runDiagnostic(options)
    assert.equal(result.readiness, 'not-evaluated')
    assert.equal(
      result.sources.length,
      2,
      'the discovery continues after a rejected candidate',
    )
  } finally {
    cleanupLedger(ledger)
  }
})

test('reports an unavailable supervisor observation instead of an empty map', async () => {
  const docker = createFakeDocker({
    supervisorStatusAvailable: false,
    capture: OBSERVER_EVENT(1, 0),
    capturePaths: {
      '/home/printer/printer_data/logs/klippy.log': OBSERVER_EVENT(1, 0),
    },
  })
  const options = runOptions(docker)
  const ledger = options.ledgerDir as string
  try {
    const result = await diagnostic.runDiagnostic(options)
    assert.equal(result.supervisorObservation, 'unavailable')
    assert.equal(result.processes, 'unavailable')
    assert.equal(result.wrapperApplied, 'unavailable')
    assert.equal(result.wrapperReason, 'supervisor-unavailable')
    assert.equal(
      result.readiness,
      'not-evaluated',
      'an unavailable observation never becomes a readiness claim',
    )
  } finally {
    cleanupLedger(ledger)
  }
})

test('reports a klippy program that is not running as its own state', async () => {
  const docker = createFakeDocker({
    supervisorStatus: 'klipper FATAL\nmoonraker RUNNING pid 43\n',
    capture: OBSERVER_EVENT(1, 0),
    capturePaths: {
      '/home/printer/printer_data/logs/klippy.log': OBSERVER_EVENT(1, 0),
    },
  })
  const options = runOptions(docker)
  const ledger = options.ledgerDir as string
  try {
    const result = await diagnostic.runDiagnostic(options)
    assert.equal(result.supervisorObservation, 'observed')
    assert.equal(result.processes.klipper, 'FATAL')
    assert.equal(result.wrapperApplied, 'unavailable')
    assert.equal(result.wrapperReason, 'program-not-running')
  } finally {
    cleanupLedger(ledger)
  }
})

test('reports an unreadable process command line without a false wrapper failure', async () => {
  const docker = createFakeDocker({
    klippyCommandReadable: false,
    capture: OBSERVER_EVENT(1, 0),
    capturePaths: {
      '/home/printer/printer_data/logs/klippy.log': OBSERVER_EVENT(1, 0),
    },
  })
  const options = runOptions(docker)
  const ledger = options.ledgerDir as string
  try {
    const result = await diagnostic.runDiagnostic(options)
    assert.equal(result.wrapperApplied, 'unavailable')
    assert.equal(result.wrapperReason, 'command-unreadable')
  } finally {
    cleanupLedger(ledger)
  }
})

test('stops with a verified wrapper failure and keeps the report', async () => {
  const docker = createFakeDocker({
    klippyArgv: ['python3', '/home/printer/klipper/klippy/klippy.py'],
    capture: OBSERVER_EVENT(1, 0),
    capturePaths: {
      '/home/printer/printer_data/logs/klippy.log': OBSERVER_EVENT(1, 0),
    },
  })
  const options = runOptions(docker)
  const ledger = options.ledgerDir as string
  try {
    await assert.rejects(
      () => diagnostic.runDiagnostic(options),
      (error: DiagnosticErrorShape) => {
        assert.equal(error.phase, 'verify')
        assert.match(error.message, /wrapper is not in the running klippy/)
        assert.equal(error.result?.wrapperApplied, false)
        assert.equal(
          error.result?.wrapperReason,
          'observer-absent-from-command',
        )
        assert.equal(error.result?.capture.reason, 'wrapper-not-applied')
        assert.equal(error.result?.readiness, 'not-evaluated')
        return true
      },
    )
    const retained = JSON.parse(
      readFileSync(join(ledger, 'result.json'), 'utf8'),
    )
    assert.equal(retained.wrapperApplied, false)
    assert.equal(
      docker.calls.filter((call) => call.args[0] === 'logs').length,
      0,
      'a capture without the wrapper proves nothing and is not taken',
    )
  } finally {
    cleanupLedger(ledger)
  }
})

test('captures the child stderr from the supervisor child log', async () => {
  const childLog = '/tmp/supervisor/klipper-stdout---2026-01-01---.log'
  const docker = createFakeDocker({
    config: CHILD_LOG_CONFIG,
    capture: '',
    childLogFiles: { [childLog]: OBSERVER_START(1) + OBSERVER_EVENT(1, 0) },
  })
  const options = runOptions(docker)
  const ledger = options.ledgerDir as string
  try {
    const result = await diagnostic.runDiagnostic(options)
    assert.equal(result.routing.kind, 'child-log')
    assert.equal(result.capture.source, 'child-log')
    assert.equal(result.capture.available, true)
    assert.equal(result.capture.observerRecords, 2)
    assert.equal(result.routing.evidence, 'observer-records')
    assert.equal(result.observerAnalysis.sessions.length, 1)
  } finally {
    cleanupLedger(ledger)
  }
})

test('reports an unavailable routing instead of aborting the run', async () => {
  const relative = SUPERVISOR_CONFIG.replace(
    'stderr_logfile=/home/printer/printer_data/logs/klippy.log',
    'stderr_logfile=klippy.log\nredirect_stderr=false',
  )
  const docker = createFakeDocker({ config: relative })
  const options = runOptions(docker)
  const ledger = options.ledgerDir as string
  try {
    const result = await diagnostic.runDiagnostic(options)
    assert.equal(result.routing.kind, 'unresolved')
    assert.equal(result.capture.available, false)
    assert.equal(result.capture.reason, 'routing-unresolved')
    assert.equal(result.readiness, 'not-evaluated')
  } finally {
    cleanupLedger(ledger)
  }
})

test('keeps the primary failure and reports every cleanup failure', async () => {
  const docker = createFakeDocker({
    fail: (args) => {
      if (args[0] === 'start')
        return { status: 1, stdout: '', stderr: 'container start refused' }
      if (args[0] === 'rm' && args.includes('open3dfm-identify-run-1'))
        return { status: 1, stdout: '', stderr: 'container removal refused' }
      if (args[0] === 'volume' && args[1] === 'rm')
        return { status: 1, stdout: '', stderr: 'volume removal refused' }
      return null
    },
  })
  const options = runOptions(docker)
  const ledger = options.ledgerDir as string
  try {
    await assert.rejects(
      () => diagnostic.runDiagnostic(options),
      (error: DiagnosticErrorShape) => {
        assert.match(error.message, /docker start failed/)
        assert.equal(error.cleanupErrors.length, 2)
        assert.equal(
          docker.calls.filter((call) => call.args[0] === 'start').length,
          1,
          'a failed run is never repeated',
        )
        assert.deepEqual(
          error.cleanupErrors.map((failure) => failure.kind).sort(),
          ['container', 'volume'],
        )
        return true
      },
    )
  } finally {
    cleanupLedger(ledger)
  }
})

test('removes every owned resource even when one removal fails', async () => {
  const docker = createFakeDocker({
    fail: (args) => {
      if (args[0] === 'rm' && args.includes('open3dfm-identify-run-1'))
        return { status: 1, stdout: '', stderr: 'container removal refused' }
      return null
    },
  })
  const options = runOptions(docker)
  const ledger = options.ledgerDir as string
  try {
    await assert.rejects(
      () => diagnostic.runDiagnostic(options),
      (error: DiagnosticErrorShape) => {
        assert.equal(error.message, 'cleanup did not complete')
        assert.equal(
          error.cleanupErrors.length,
          2,
          'the volume stays in use while the container still mounts it',
        )
        assert.deepEqual(
          error.cleanupErrors.map((failure) => failure.kind).sort(),
          ['container', 'volume'],
        )
        assert.equal(error.result?.readiness, 'not-evaluated')
        assert.equal(error.result?.cleanup.completed, false)
        return true
      },
    )
    const removals = removalCalls(docker)
    assert.equal(removals.length >= 3, true, 'the volume removal still runs')
  } finally {
    cleanupLedger(ledger)
  }
})

test('retries a removal that failed once without touching the removed resources', async () => {
  const docker = createFakeDocker({
    failOnce: (args) => {
      if (args[0] === 'rm' && args.includes('open3dfm-identify-run-1'))
        return { status: 1, stdout: '', stderr: 'container removal refused' }
      return null
    },
    capture: OBSERVER_START(1),
    capturePaths: {
      '/home/printer/printer_data/logs/klippy.log': OBSERVER_START(1),
    },
  })
  const options = runOptions(docker)
  const ledger = options.ledgerDir as string
  try {
    const result = await diagnostic.runDiagnostic(options)
    assert.equal(
      result.cleanup.completed,
      true,
      'a removal that succeeds on the retry leaves no cleanup error',
    )
    assert.deepEqual(result.cleanup.errors, [])
    assert.ok(result.cleanup.firstAttemptErrors.length > 0)
    const containerRemovals = docker.calls.filter(
      (call) =>
        call.args[0] === 'rm' && call.args.includes('open3dfm-identify-run-1'),
    )
    assert.equal(
      containerRemovals.length,
      2,
      'the container that failed is removed again on the retry',
    )
    const inspectionRemovals = docker.calls.filter(
      (call) =>
        call.args[0] === 'rm' &&
        call.args.includes('open3dfm-identify-run-1-inspect'),
    )
    assert.equal(
      inspectionRemovals.length,
      1,
      'a resource that was already removed is never removed twice',
    )
    const volumeRemovals = docker.calls.filter(
      (call) => call.args[0] === 'volume' && call.args[1] === 'rm',
    )
    assert.equal(
      volumeRemovals.length,
      2,
      'the volume is retried once the container no longer mounts it',
    )
  } finally {
    cleanupLedger(ledger)
  }
})

test('refuses to remove a resource that does not carry the run label', async () => {
  const docker = createFakeDocker({
    labels: { 'com.open3dfarmmanager.identify-diagnostic': 'someone-else' },
  })
  const options = runOptions(docker)
  const ledger = options.ledgerDir as string
  try {
    await assert.rejects(
      () => diagnostic.runDiagnostic(options),
      (error: DiagnosticErrorShape) => error.message.includes('cleanup'),
    )
    assert.equal(
      docker.calls.filter((call) => call.args[0] === 'rm').length,
      0,
      'an unverified resource is never removed',
    )
  } finally {
    cleanupLedger(ledger)
  }
})

test('stops on a docker timeout without a retry', async () => {
  const docker = createFakeDocker({ timedOutCommands: ['start'] })
  const options = runOptions(docker)
  const ledger = options.ledgerDir as string
  try {
    await assert.rejects(
      () => diagnostic.runDiagnostic(options),
      (error: DiagnosticErrorShape) => {
        assert.match(error.message, /timed out/)
        assert.equal(error.phase, 'observe')
        return true
      },
    )
    assert.equal(
      docker.calls.filter((call) => call.args[0] === 'start').length,
      1,
      'a timed out run is never started again',
    )
  } finally {
    cleanupLedger(ledger)
  }
})

test('bounds the observation polling to the remaining window', async () => {
  const docker = createFakeDocker({
    capture: OBSERVER_EVENT(1, 0),
    capturePaths: {
      '/home/printer/printer_data/logs/klippy.log': OBSERVER_EVENT(1, 0),
    },
  })
  const options = runOptions(docker, { observationMs: 4_000 })
  const ledger = options.ledgerDir as string
  try {
    const result = await diagnostic.runDiagnostic(options)
    assert.equal(result.observation.exceededBudget, false)
    const polls = docker.calls.filter(
      (call) =>
        call.args[0] === 'inspect' && call.args.includes('{{.State.Status}}'),
    )
    assert.equal(polls.length > 0, true)
    for (const poll of polls) {
      assert.equal(typeof poll.timeoutMs, 'number')
      assert.equal(
        (poll.timeoutMs as number) <= 4_000,
        true,
        'a polling call never receives more than the remaining window',
      )
    }
  } finally {
    cleanupLedger(ledger)
  }
})

// ---------------------------------------------------------------------------
// Ledger isolation
// ---------------------------------------------------------------------------

test('keeps the ledger outside the repository and every linked worktree', async () => {
  const docker = createFakeDocker()
  const roots = diagnostic.repositoryExclusionRoots()
  assert.equal(roots.length > 0, true)
  for (const root of roots) {
    const inside = join(root, 'tmp-identify-ledger')
    assert.throws(
      () => diagnostic.assertLedgerOutsideRepository(inside),
      (error: DiagnosticErrorShape) => error.message.includes('outside'),
      `${root} must be refused as a ledger root`,
    )
    assert.equal(
      existsSync(inside),
      false,
      'the refusal happens before anything is created',
    )
  }
  const options = runOptions(docker)
  const ledger = options.ledgerDir as string
  try {
    const inside = join(diagnostic.REPOSITORY_ROOT, 'tmp-identify-ledger')
    await assert.rejects(
      () => diagnostic.runDiagnostic(runOptions(docker, { ledgerDir: inside })),
      (error: DiagnosticErrorShape) => error.message.includes('outside'),
    )
    assert.equal(
      existsSync(inside),
      false,
      'a refused ledger leaves no directory inside the repository',
    )
  } finally {
    cleanupLedger(ledger)
  }
})

test('refuses a ledger that reaches the repository through a symlink', async () => {
  const docker = createFakeDocker()
  const external = mkdtempSync(join(tmpdir(), 'open3dfm-identify-link-'))
  try {
    const link = join(external, 'repository')
    symlinkSync(diagnostic.REPOSITORY_ROOT, link, 'dir')
    const throughLink = join(link, 'tmp-identify-ledger')
    assert.throws(
      () => diagnostic.assertLedgerOutsideRepository(throughLink),
      (error: DiagnosticErrorShape) => error.message.includes('outside'),
    )
    const options = runOptions(docker, { ledgerDir: throughLink })
    const ledger = options.ledgerDir as string
    try {
      await assert.rejects(
        () => diagnostic.runDiagnostic(options),
        (error: DiagnosticErrorShape) => error.message.includes('outside'),
      )
    } finally {
      cleanupLedger(ledger)
    }
  } finally {
    rmSync(external, { recursive: true, force: true })
  }
})

test('resolves a canonical ledger path outside the repository', () => {
  const external = mkdtempSync(join(tmpdir(), 'open3dfm-identify-canonical-'))
  try {
    const canonical = diagnostic.assertLedgerOutsideRepository(
      join(external, 'evidence'),
    )
    assert.equal(canonical, join(realpathSync(external), 'evidence'))
    assert.equal(diagnostic.canonicalPath(external), realpathSync(external))
  } finally {
    rmSync(external, { recursive: true, force: true })
  }
})

test('real observer treats capture loss and overflow as incomplete', () => {
  const event = (value: object) =>
    OBSERVER_PREFIX + JSON.stringify(value) + '\n'
  const records =
    event({ event: 'start', session: 1 }) +
    event({
      event: 'identify',
      session: 1,
      requested: 0,
      offset: 0,
      length: 0,
    }) +
    event({ event: 'result', session: 1, success: true })
  for (const [input, truncated] of [
    [records, true],
    [records + OBSERVER_PREFIX + '{\n', false],
    [
      records +
        event({ event: 'disconnect', session: 1, counters: {} }).repeat(4100),
      false,
    ],
  ] as const) {
    const prepared = diagnostic.prepareAnalyzerInput(input, truncated)
    assert.equal(prepared.notified, true)
    assert.ok(prepared.text.trimEnd().split('\n').length <= 4097)
    const python = spawnSync(
      'python3',
      [
        join(
          diagnostic.REPOSITORY_ROOT,
          'infra/sim/experiments/serial_diagnostic.py',
        ),
        'analyze',
      ],
      { input: prepared.text, encoding: 'utf8' },
    )
    assert.equal(python.status, 0, python.stderr)
    const analysis = JSON.parse(python.stdout)
    assert.equal(analysis.truncated, true)
    assert.ok(
      analysis.sessions.every(
        (session: { classification: string }) =>
          session.classification === 'inconclusive-incomplete-capture',
      ),
    )
  }
  assert.equal(
    diagnostic.prepareAnalyzerInput(
      records + event({ event: 'start', session: 1 }),
    ).reusedSession,
    true,
  )
})

test('container log line cap forces incomplete analysis', async () => {
  const config = SUPERVISOR_CONFIG.replace(
    'stdout_logfile=/home/printer/printer_data/logs/klippy.log',
    'redirect_stderr=false',
  ).replace('stderr_logfile=/home/printer/printer_data/logs/klippy.log\n', '')
  const records =
    OBSERVER_START(1) + OBSERVER_EVENT(1, 0) + OBSERVER_RESULT(1, true)
  const docker = createFakeDocker({
    config,
    capture: 'other\n'.repeat(3) + records + 'other\n'.repeat(4997),
  })
  const options = runOptions(docker)
  try {
    const result = await diagnostic.runDiagnostic(options)
    assert.equal(result.capture.source, 'container-output')
    assert.equal(result.capture.truncated, true)
    assert.equal(result.capture.truncationNotifiedToAnalyzer, true)
    assert.equal(
      result.observerAnalysis.sessions[0].classification,
      'inconclusive-incomplete-capture',
    )
  } finally {
    cleanupLedger(options.ledgerDir as string)
  }
})

test('reused session IDs suppress merged classifications', async () => {
  const records =
    OBSERVER_START(1) +
    OBSERVER_EVENT(1, 0) +
    OBSERVER_RESULT(1, false) +
    OBSERVER_START(1) +
    OBSERVER_RESULT(1, true)
  const docker = createFakeDocker({ capture: records })
  const options = runOptions(docker)
  try {
    const result = await diagnostic.runDiagnostic(options)
    assert.equal(result.capture.sessionIdReused, true)
    assert.equal(result.observerAnalysis, null)
    assert.match(result.observerAnalysisError, /session ID reuse/)
  } finally {
    cleanupLedger(options.ledgerDir as string)
  }
})

test('rejects relative Supervisor configuration paths before copying', async () => {
  const docker = createFakeDocker({
    entrypoint: 'exec supervisord -c relative.conf\n',
  })
  const options = runOptions(docker)
  try {
    await assert.rejects(
      () => diagnostic.runDiagnostic(options),
      /absolute supervisor configuration path/,
    )
  } finally {
    cleanupLedger(options.ledgerDir as string)
  }
})

test('ledger file collision does not overwrite or follow a symlink', async () => {
  const docker = createFakeDocker()
  const options = runOptions(docker)
  const ledger = options.ledgerDir as string
  const target = join(ledger, 'untouched')
  writeFileSync(target, 'keep', { mode: 0o600 })
  symlinkSync(target, join(ledger, 'baseline.txt'))
  try {
    await assert.rejects(() => diagnostic.runDiagnostic(options))
    assert.equal(readFileSync(target, 'utf8'), 'keep')
  } finally {
    cleanupLedger(ledger)
  }
})

test('reports cleanup retries including the original failure', async () => {
  let count = 0
  const docker = createFakeDocker({
    fail: (args) => {
      if (
        args[0] === 'inspect' &&
        args.includes('open3dfm-identify-run-1-inspect') &&
        args.includes('--format')
      ) {
        count++
        return {
          status: 1,
          stdout: '',
          stderr: count === 1 ? 'connection refused' : 'different error',
        }
      }
      return null
    },
  })
  const options = runOptions(docker)
  try {
    await assert.rejects(
      () => diagnostic.runDiagnostic(options),
      (error: DiagnosticErrorShape) => {
        assert.match(
          error.cleanupErrors[0]?.message ?? '',
          /docker inspect failed.*retry: docker inspect failed/,
        )
        return true
      },
    )
  } finally {
    cleanupLedger(options.ledgerDir as string)
  }
})

test('an already absent resource is distinct from an inspect failure', async () => {
  const docker = createFakeDocker({
    fail: (args) =>
      args[0] === 'inspect' &&
      args.includes('open3dfm-identify-run-1-inspect') &&
      args.includes('--format')
        ? {
            status: 1,
            stdout: '',
            stderr: 'Error: No such container: open3dfm-identify-run-1-inspect',
          }
        : null,
  })
  const options = runOptions(docker)
  try {
    const result = await diagnostic.runDiagnostic(options)
    assert.equal(result.cleanup.completed, true)
  } finally {
    cleanupLedger(options.ledgerDir as string)
  }
})

test('byte-bounded capture is incomplete in the real observer', () => {
  const records =
    OBSERVER_START(1) + OBSERVER_EVENT(1, 0) + OBSERVER_RESULT(1, true)
  const bounded = diagnostic.boundCapture(
    'noise\n'.repeat(50) + records,
    Buffer.byteLength(records) + 1,
  )
  assert.equal(bounded.truncated, true)
  const prepared = diagnostic.prepareAnalyzerInput(
    bounded.text,
    bounded.truncated,
  )
  const python = spawnSync(
    'python3',
    [
      join(
        diagnostic.REPOSITORY_ROOT,
        'infra/sim/experiments/serial_diagnostic.py',
      ),
      'analyze',
    ],
    { input: prepared.text, encoding: 'utf8' },
  )
  assert.equal(python.status, 0, python.stderr)
  const analysis = JSON.parse(python.stdout)
  assert.equal(analysis.truncated, true)
  assert.equal(
    analysis.sessions[0].classification,
    'inconclusive-incomplete-capture',
  )
})

test('caller cannot replace reviewed source pins', async () => {
  const docker = createFakeDocker({ badSource: true })
  const options = {
    ...runOptions(docker),
    resolveSourcePins: () => ({
      'klippy/serialhdl.py': sha256('wrong source'),
      'klippy/chelper/serialqueue.c': sha256(SERIALQUEUE),
    }),
  }
  try {
    await assert.rejects(
      () => diagnostic.runDiagnostic(options),
      /reviewed hash/,
    )
  } finally {
    cleanupLedger(options.ledgerDir as string)
  }
})

test('Git discovery failure refuses ledger preflight before creation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'open3dfm-git-discovery-'))
  const actualGit = spawnSync('which', ['git'], {
    encoding: 'utf8',
  }).stdout.trim()
  assert.ok(actualGit)
  try {
    writeFileSync(
      join(dir, 'git'),
      `#!/bin/sh
case "$DISCOVERY_FAILURE:$3" in
  common:rev-parse|worktrees:worktree) exit 1 ;;
  empty:worktree) exit 0 ;;
  corrupt:worktree) \"$ACTUAL_GIT\" \"$@\"; printf 'HEAD deadbeef\\0\\0'; exit 0 ;;
  malformed:worktree) printf 'worktree relative-path\\n'; exit 0 ;;
esac
exec "$ACTUAL_GIT" "$@"
`,
      { mode: 0o700 },
    )
    for (const mode of [
      'common',
      'worktrees',
      'empty',
      'malformed',
      'corrupt',
    ]) {
      const ledger = join(dir, mode, 'ledger')
      const source = `import assert from 'node:assert/strict';
        import { existsSync } from 'node:fs';
        const m = await import(process.argv[1]);
        await assert.rejects(m.runDiagnostic({ledgerDir: process.argv[2], docker: {run() {throw Error('Docker must not run')}}}), e => e.phase === 'preflight');
        assert.equal(existsSync(process.argv[2]), false);`
      const result = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', source, moduleUrl, ledger],
        {
          encoding: 'utf8',
          timeout: 10000,
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            ACTUAL_GIT: actualGit,
            DISCOVERY_FAILURE: mode,
          },
        },
      )
      assert.equal(result.status, 0, `${mode}: ${result.stderr}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

for (const creation of ['inspection', 'volume', 'container']) {
  test(`reconciles ${creation} creation after a lost successful response`, async () => {
    const docker = createFakeDocker()
    const original = docker.run.bind(docker)
    let attemptedName = ''
    docker.run = async (args, options) => {
      const result = await original(args, options)
      const name = args[args.indexOf('--name') + 1] ?? ''
      const matches =
        creation === 'volume'
          ? args[0] === 'volume' && args[1] === 'create'
          : args[0] === 'create' &&
            name.endsWith('-inspect') === (creation === 'inspection')
      if (matches) {
        attemptedName = creation === 'volume' ? (args.at(-1) ?? '') : name
        return { status: null, stdout: '', stderr: '', timedOut: true }
      }
      return result
    }
    const options = runOptions(docker)
    try {
      await assert.rejects(diagnostic.runDiagnostic(options), /timed out/)
      assert.ok(attemptedName)
      assert.ok(
        removalCalls(docker).some((args) => args.at(-1) === attemptedName),
      )
    } finally {
      cleanupLedger(options.ledgerDir as string)
    }
  })
}
