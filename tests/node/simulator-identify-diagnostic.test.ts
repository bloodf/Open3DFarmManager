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
  resolveSourcePins?: () => Record<string, string>
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

const SERIALHDL = '# klippy serialhdl source fixture\n'
const SERIALQUEUE = '/* klippy serialqueue source fixture */\n'

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
  timedOutCommands?: string[]
}

function createFakeDocker(options: FakeOptions = {}): FakeDocker {
  const files = new Map<string, string>([
    ['/usr/local/bin/start.sh', options.entrypoint ?? ENTRYPOINT_SCRIPT],
    ['/usr/local/etc/supervisord.conf', options.config ?? SUPERVISOR_CONFIG],
    ['/home/printer/klipper/klippy/serialhdl.py', SERIALHDL],
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
      if (command === 'logs')
        return { status: 0, stdout: options.capture ?? '', stderr: '' }
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
        if (target === 'printenv') {
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
  const ledger = createLedger()
  const { clock, sleep } = createClock()
  return {
    docker,
    clock,
    sleep,
    ledgerDir: ledger,
    runId: 'run-1',
    runName: 'open3dfm-identify-run-1',
    observationMs: 5_000,
    resolveSourcePins: () => ({
      'klippy/serialhdl.py': sha256(SERIALHDL),
      'klippy/chelper/serialqueue.c': sha256(SERIALQUEUE),
    }),
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
    cleanupLedger(runOptions(docker).ledgerDir as string)
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
      'valid-incomplete-identification',
    )
    assert.equal(result.capture.observerRecords, 4)
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
  const docker = createFakeDocker()
  const options = runOptions(docker, {
    resolveSourcePins: () => ({
      'klippy/serialhdl.py': sha256('different content'),
      'klippy/chelper/serialqueue.c': sha256(SERIALQUEUE),
    }),
  })
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
