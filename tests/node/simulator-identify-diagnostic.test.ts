import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

interface DiagnosticErrorShape {
  message: string
  phase: string
  cleanupErrors: { kind: string; name: string; message: string }[]
}

interface DiagnosticModule {
  OPT_IN_TOKEN: string
  PINNED_IMAGE_REFERENCE: string
  PINNED_AMD64_DIGEST: string
  READINESS_BUDGET_MS: number
  OBSERVER_MOUNT_PATH: string
  CAPTURE_BYTE_LIMIT: number
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
  parseSupervisorConfig(text: string): {
    sections: {
      type: string
      name: string
      entries: { key: string; value: string; line: number }[]
    }[]
  }
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
  resolveStderrRouting(section: {
    entries: { key: string; value: string; line: number }[]
  }): { kind: string; path: string | null }
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
  runDiagnostic(options: RunOptions): Promise<Record<string, any>>
}

interface FakeResult {
  status: number
  stdout: string
  stderr: string
  timedOut?: boolean
}

interface FakeDocker {
  run(args: string[], options?: { input?: string }): Promise<FakeResult>
  calls: string[][]
}

interface RunOptions {
  docker: FakeDocker
  clock?: { now: () => number }
  sleep?: (ms: number) => Promise<void>
  ledgerDir?: string
  observationMs?: number
  resolveSourcePins?: () => Record<string, string>
  runId: string
  runName: string
}

const moduleUrl = new URL(
  '../../scripts/simulator-identify-diagnostic.mjs',
  import.meta.url,
).href
const diagnostic = (await import(moduleUrl)) as unknown as DiagnosticModule

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

const SERIALHDL = '# klippy serialhdl source fixture\n'
const SERIALQUEUE = '/* klippy serialqueue source fixture */\n'

const OBSERVER_EVENT = (session: number, bytes: number) =>
  `O3DFM_SERIAL_DIAGNOSTIC {"event": "identify", "session": ${session}, "elapsed": 1.5, "requested": ${bytes}, "offset": ${bytes}, "length": 40}\n`

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

interface FakeOptions {
  config?: string
  entrypoint?: string
  capture?: string
  analysis?: unknown
  labels?: Record<string, string>
  containerStatus?: string
  supervisorStatus?: string
  klippyArgv?: string[]
  fail?: (args: string[]) => FakeResult | null
  missingFiles?: string[]
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
  const fake: FakeDocker = {
    calls: [],
    async run(args: string[]): Promise<FakeResult> {
      fake.calls.push(args)
      const failure = options.fail?.(args)
      if (failure) return failure
      const [command, ...rest] = args
      if (command === 'create')
        return { status: 0, stdout: 'container-id\n', stderr: '' }
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
          if (format.includes('.Config.Labels'))
            return { status: 0, stdout: JSON.stringify(labels), stderr: '' }
          if (format.includes('.State.Status'))
            return {
              status: 0,
              stdout: options.containerStatus ?? 'running\n',
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
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              Config: {
                Entrypoint: ['/usr/local/bin/start.sh'],
                Cmd: [],
              },
            },
          ]),
          stderr: '',
        }
      }
      if (command === 'volume') {
        const sub = rest[0]
        if (sub === 'create')
          return { status: 0, stdout: 'volume-name\n', stderr: '' }
        if (sub === 'inspect')
          return { status: 0, stdout: JSON.stringify(labels), stderr: '' }
        if (sub === 'rm') return { status: 0, stdout: '', stderr: '' }
        return { status: 0, stdout: '', stderr: '' }
      }
      if (command === 'rm') return { status: 0, stdout: '', stderr: '' }
      if (command === 'logs')
        return { status: 0, stdout: options.capture ?? '', stderr: '' }
      if (command === 'exec') {
        const execArgv = rest[0] === '-i' ? rest.slice(1) : rest
        const target = execArgv[1] ?? ''
        if (target === 'supervisorctl')
          return {
            status: 0,
            stdout:
              options.supervisorStatus ??
              'klipper RUNNING pid 42\nmoonraker RUNNING pid 43\nsimulavr RUNNING pid 44\nwebcamd RUNNING pid 45\n',
            stderr: '',
          }
        if (target === 'cat' && (execArgv[2] ?? '').startsWith('/proc/'))
          return {
            status: 0,
            stdout: (
              options.klippyArgv ?? [
                'python3',
                '/opt/o3dfm/serial_diagnostic.py',
                'observe',
                '/home/printer/klipper',
                '--',
              ]
            ).join('\0'),
            stderr: '',
          }
        if (target === 'tail')
          return { status: 0, stdout: options.capture ?? '', stderr: '' }
        if (target === 'python3')
          return {
            status: 0,
            stdout: JSON.stringify(
              options.analysis ?? {
                truncated: false,
                sessions: [
                  {
                    session: 1,
                    accepted_bytes: 680,
                    unmatched_responses: 0,
                    terminal_response: false,
                    counters: {
                      bytes_write: 40,
                      bytes_read: 680,
                      bytes_retransmit: 0,
                      bytes_invalid: 0,
                    },
                    finished: false,
                    success: false,
                    started: true,
                    observer_error: false,
                    last_identify_elapsed: 3.33,
                    classification: 'valid-incomplete-identification',
                  },
                ],
              },
            ),
            stderr: '',
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

test('resolves the child stderr routing from the extracted configuration', () => {
  const config = diagnostic.parseSupervisorConfig(SUPERVISOR_CONFIG)
  const program = diagnostic.findKlipperProgram(config).section
  assert.deepEqual(diagnostic.resolveStderrRouting(program), {
    kind: 'stderr-file',
    path: '/home/printer/printer_data/logs/klippy.log',
  })
  const redirected = SUPERVISOR_CONFIG.replace(
    'stderr_logfile=/home/printer/printer_data/logs/klippy.log',
    'redirect_stderr=true',
  )
  const redirectedProgram = diagnostic.findKlipperProgram(
    diagnostic.parseSupervisorConfig(redirected),
  ).section
  assert.deepEqual(diagnostic.resolveStderrRouting(redirectedProgram), {
    kind: 'stdout-file',
    path: '/home/printer/printer_data/logs/klippy.log',
  })
  const inherited = SUPERVISOR_CONFIG.replace(
    'stderr_logfile=/home/printer/printer_data/logs/klippy.log\n',
    '',
  )
  const inheritedProgram = diagnostic.findKlipperProgram(
    diagnostic.parseSupervisorConfig(inherited),
  ).section
  assert.deepEqual(diagnostic.resolveStderrRouting(inheritedProgram), {
    kind: 'container-stdout',
    path: null,
  })
})

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
            started: true,
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
            started: true,
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
    args.some((argument) => argument === '--device'),
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
  assert.throws(
    () => diagnostic.assertContainerIsolation([...args, '--privileged']),
    (error: DiagnosticErrorShape) => error.message.includes('forbidden'),
  )
  assert.throws(
    () =>
      diagnostic.assertContainerIsolation([
        ...args.filter((argument) => !argument.endsWith(':ro')),
      ]),
    (error: DiagnosticErrorShape) => error.message.includes('writable'),
  )
})

test('collects a bounded observation and reports no readiness acceptance', async () => {
  const docker = createFakeDocker({
    capture: OBSERVER_EVENT(1, 0) + OBSERVER_EVENT(1, 40),
  })
  const options = runOptions(docker)
  const ledger = options.ledgerDir as string
  try {
    const result = await diagnostic.runDiagnostic(options)
    assert.equal(result.readiness, 'not-evaluated')
    assert.equal(result.wrapperApplied, true)
    assert.equal(result.observerAnalysis.sessions.length, 1)
    assert.equal(
      result.observerAnalysis.sessions[0].classification,
      'valid-incomplete-identification',
    )
    assert.equal(result.capture.observerRecords, 2)
    assert.equal(result.capture.reason, 'observer-records-captured')
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
    const starts = docker.calls.filter((call) => call[0] === 'start')
    assert.equal(starts.length, 1, 'the run is never repeated')
    const creates = docker.calls.filter((call) => call[0] === 'create')
    assert.equal(
      creates.length,
      2,
      'one inspection container and one run container',
    )
    for (const call of creates) assert.equal(call.includes('--pull'), true)
    const removals = docker.calls.filter(
      (call) => call[0] === 'rm' || (call[0] === 'volume' && call[1] === 'rm'),
    )
    assert.equal(removals.length, 3)
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
  const oversized = 'O3DFM_SERIAL_DIAGNOSTIC {}\n'.repeat(
    Math.ceil(diagnostic.CAPTURE_BYTE_LIMIT / 24) + 10,
  )
  const docker = createFakeDocker({ capture: oversized })
  const options = runOptions(docker)
  const ledger = options.ledgerDir as string
  try {
    const result = await diagnostic.runDiagnostic(options)
    assert.equal(result.capture.bytes, diagnostic.CAPTURE_BYTE_LIMIT)
    assert.equal(result.capture.truncated, true)
  } finally {
    cleanupLedger(ledger)
  }
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
      docker.calls.filter((call) => call[0] === 'start').length,
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
    assert.equal(docker.calls.filter((call) => call[0] === 'start').length, 0)
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
          docker.calls.filter((call) => call[0] === 'start').length,
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
      (error: DiagnosticErrorShape & { result?: Record<string, unknown> }) => {
        assert.equal(error.message, 'cleanup did not complete')
        assert.equal(error.cleanupErrors.length, 1)
        assert.equal(error.result?.readiness, 'not-evaluated')
        return true
      },
    )
    const removals = docker.calls.filter(
      (call) => call[0] === 'rm' || (call[0] === 'volume' && call[1] === 'rm'),
    )
    assert.equal(removals.length, 3, 'the volume removal still runs')
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
      docker.calls.filter((call) => call[0] === 'rm').length,
      0,
      'an unverified resource is never removed',
    )
  } finally {
    cleanupLedger(ledger)
  }
})

test('keeps the ledger outside the repository', async () => {
  const docker = createFakeDocker()
  const inside = join(process.cwd(), 'tmp-identify-ledger')
  mkdirSync(inside, { recursive: true })
  try {
    await assert.rejects(
      () => diagnostic.runDiagnostic(runOptions(docker, { ledgerDir: inside })),
      (error: DiagnosticErrorShape) => error.message.includes('outside'),
    )
  } finally {
    rmSync(inside, { recursive: true, force: true })
  }
})
