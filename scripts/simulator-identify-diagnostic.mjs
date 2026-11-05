#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Opt-in, bounded identification diagnostic for the pinned synthetic simulator.
//
// The runner is a diagnostic instrument, not a gate. It never reports readiness,
// never retries a failed run and never promotes a result to a CI pass. It reuses
// the existing observer unchanged and emits only validated observer data plus
// process lifecycle metadata.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const OPT_IN_TOKEN = 'synthetic-identification-diagnostic'
export const PINNED_IMAGE_REFERENCE =
  'ghcr.io/mainsail-crew/virtual-klipper-printer@sha256:c2ab1d20a3f6d9dda182bf69a078c5f37a066a44f1f34ffea48d49ddf7bbce47'
export const PINNED_AMD64_DIGEST =
  'sha256:c2ab1d20a3f6d9dda182bf69a078c5f37a066a44f1f34ffea48d49ddf7bbce47'
export const PINNED_PLATFORM = 'linux/amd64'
export const OBSERVER_SOURCE_SHA256 =
  '791805817b88d1f365a49a2c968c028026a95d8b6fb500f2956af833e05033fb'
export const OBSERVER_MOUNT_PATH = '/opt/o3dfm/serial_diagnostic.py'
export const OBSERVER_PREFIX = 'O3DFM_SERIAL_DIAGNOSTIC '
export const READINESS_BUDGET_MS = 90_000
export const DOCKER_CALL_TIMEOUT_MS = 10_000
export const CAPTURE_BYTE_LIMIT = 1024 * 1024
export const ENTRYPOINT_SCRIPT_BYTE_LIMIT = 256 * 1024
export const SUPERVISOR_CONFIG_BYTE_LIMIT = 256 * 1024
export const OBSERVER_CLASSIFICATIONS = [
  'valid-incomplete-identification',
  'identification-complete-not-readiness',
  'inconclusive-unmatched-responses',
  'inconclusive-invalid-or-sequence-rejected-traffic',
  'inconclusive-no-identification-progress',
  'inconclusive-dictionary-not-loaded',
  'inconclusive-incomplete-capture',
]
export const SUPERVISOR_PROGRAMS = [
  'klipper',
  'moonraker',
  'simulavr',
  'webcamd',
]
export const COUNTER_KEYS = [
  'bytes_write',
  'bytes_read',
  'bytes_retransmit',
  'bytes_invalid',
]

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url))
export const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, '..')
const KLIPPY_SCRIPT_SUFFIX = '/klippy/klippy.py'
const SHELL_METACHARACTERS = /[;&|<>`$(){}\[\]!*?\\\n\r]/

export class DiagnosticError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'DiagnosticError'
    this.phase = options.phase ?? 'unknown'
    this.cause = options.cause
    this.cleanupErrors = options.cleanupErrors ?? []
  }
}

export function sha256(input) {
  return createHash('sha256').update(input).digest('hex')
}

function diagnostic(message, phase, cause) {
  return new DiagnosticError(message, { phase, cause })
}

// ---------------------------------------------------------------------------
// Supervisor configuration parsing
// ---------------------------------------------------------------------------

/**
 * Parse a Supervisor INI configuration. Section order, entry order, line
 * indexes and the original text are preserved so that a transformation can
 * change exactly one value and nothing else.
 */
export function parseSupervisorConfig(text) {
  if (typeof text !== 'string' || text.length === 0)
    throw diagnostic('empty supervisor configuration', 'parse')
  const lines = text.split('\n')
  const sections = []
  let current = null
  let entry = null
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const header = /^\[([^\]]+)\]$/.exec(trimmed)
    if (header) {
      const raw = header[1].trim()
      const colon = raw.indexOf(':')
      const type = colon === -1 ? raw : raw.slice(0, colon)
      const name = colon === -1 ? '' : raw.slice(colon + 1).trim()
      current = {
        type,
        name,
        header: trimmed,
        startLine: index,
        endLine: index,
        entries: [],
      }
      sections.push(current)
      entry = null
      continue
    }
    if (/^\s/.test(line) && entry) {
      // Supervisor continues an indented value on the next line.
      entry.value = `${entry.value}\n${trimmed}`
      entry.continuation = true
      current.endLine = index
      continue
    }
    const separator = line.indexOf('=')
    if (separator === -1)
      throw diagnostic(
        `unsupported supervisor configuration syntax at line ${index + 1}`,
        'parse',
      )
    const key = line.slice(0, separator).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      throw diagnostic(
        `unsupported supervisor configuration key at line ${index + 1}`,
        'parse',
      )
    if (!current)
      throw diagnostic(
        `supervisor configuration value outside a section at line ${index + 1}`,
        'parse',
      )
    entry = {
      key,
      value: line.slice(separator + 1).trim(),
      line: index,
      continuation: false,
    }
    current.entries.push(entry)
    current.endLine = index
  }
  if (sections.length === 0)
    throw diagnostic('supervisor configuration has no sections', 'parse')
  return { text, lines, sections }
}

/**
 * Tokenize a Supervisor command value the way Supervisor does, without ever
 * evaluating it as a shell string. Backslash, quote and metacharacter handling
 * is explicit and anything unexpected is refused.
 */
export function parseSupervisorCommand(value) {
  if (typeof value !== 'string')
    throw diagnostic('supervisor command is not a string', 'parse')
  const tokens = []
  let current = ''
  let quote = null
  let started = false
  for (const character of value) {
    if (quote) {
      if (character === quote) {
        quote = null
        continue
      }
      if (quote === '"' && character === '\\') {
        current += character
        continue
      }
      current += character
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      started = true
      continue
    }
    if (character === '\\') {
      current += character
      started = true
      continue
    }
    if (/\s/.test(character)) {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += character
    started = true
  }
  if (quote) throw diagnostic('unbalanced quote in supervisor command', 'parse')
  if (started) tokens.push(current)
  if (tokens.length === 0)
    throw diagnostic('supervisor command is empty', 'parse')
  for (const token of tokens) {
    if (token.length === 0)
      throw diagnostic('empty argument in supervisor command', 'parse')
    if (SHELL_METACHARACTERS.test(token))
      throw diagnostic(
        'supervisor command contains a shell metacharacter',
        'parse',
      )
    if (/\s/.test(token))
      throw diagnostic(
        'supervisor command argument contains whitespace',
        'parse',
      )
    if (/['"\\]/.test(token))
      throw diagnostic(
        'supervisor command argument contains a quoting character',
        'parse',
      )
  }
  return { tokens }
}

/** Return the single `program` section named `klipper` and its command. */
export function findKlipperProgram(config) {
  const programs = config.sections.filter(
    (section) => section.type === 'program' && section.name === 'klipper',
  )
  if (programs.length !== 1)
    throw diagnostic(
      `expected exactly one [program:klipper] section, found ${programs.length}`,
      'parse',
    )
  const section = programs[0]
  const commands = section.entries.filter((entry) => entry.key === 'command')
  if (commands.length !== 1)
    throw diagnostic(
      `expected exactly one command in [program:klipper], found ${commands.length}`,
      'parse',
    )
  return { section, command: commands[0] }
}

function entryValue(section, key) {
  const found = section.entries.find((entry) => entry.key === key)
  return found ? found.value : undefined
}

function isAbsoluteContainerPath(value) {
  return (
    typeof value === 'string' &&
    value.startsWith('/') &&
    !value.includes('..') &&
    !value.includes('//') &&
    /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
  )
}

/**
 * Rewrite only the Klippy command of the pinned Supervisor configuration.
 *
 * The interpreter, its flags, the Klippy arguments, the restart and retry
 * policy and every other program are preserved. The returned delta never
 * contains the configuration text.
 */
// Only the restart and retry policy is reported. Paths, environment values and
// log destinations stay in the external ledger, never in the report.
const PRESERVED_DIRECTIVE_KEYS = [
  'autorestart',
  'startretries',
  'startsecs',
  'priority',
  'stopsignal',
  'stopwaitsecs',
  'exitcodes',
  'umask',
]

export function transformSupervisorConfig(text, options) {
  const observerPath = options.observerPath
  const config = parseSupervisorConfig(text)
  const { section, command } = findKlipperProgram(config)
  if (command.continuation)
    throw diagnostic('multi-line klippy command is not supported', 'transform')
  const { tokens } = parseSupervisorCommand(command.value)
  const scriptIndexes = []
  tokens.forEach((token, index) => {
    if (token.endsWith(KLIPPY_SCRIPT_SUFFIX)) scriptIndexes.push(index)
  })
  if (scriptIndexes.length !== 1)
    throw diagnostic(
      'klippy command does not contain exactly one klippy script argument',
      'transform',
    )
  const scriptIndex = scriptIndexes[0]
  const scriptPath = tokens[scriptIndex]
  if (!isAbsoluteContainerPath(scriptPath))
    throw diagnostic('klippy script path is not absolute', 'transform')
  const interpreter = tokens.slice(0, scriptIndex)
  if (interpreter.length === 0)
    throw diagnostic('klippy command has no interpreter', 'transform')
  for (const token of interpreter) {
    const executable = /^(?:\/usr\/bin\/)?python3(?:\.\d+)?$/.test(token)
    const flag = /^-[A-Za-z]+$/.test(token)
    if (!executable && !flag)
      throw diagnostic(
        'unsupported interpreter invocation in klippy command',
        'transform',
      )
  }
  const klippyArguments = tokens.slice(scriptIndex + 1)
  const root = scriptPath.slice(
    0,
    scriptPath.length - KLIPPY_SCRIPT_SUFFIX.length,
  )
  if (!isAbsoluteContainerPath(root))
    throw diagnostic(
      'derived klipper root is not a safe absolute path',
      'transform',
    )
  if (!isAbsoluteContainerPath(observerPath))
    throw diagnostic(
      'observer mount path is not a safe absolute path',
      'transform',
    )

  const replacement = [
    ...interpreter,
    observerPath,
    'observe',
    root,
    '--',
    ...klippyArguments,
  ].join(' ')

  const lines = config.lines.slice()
  const original = lines[command.line]
  const separator = original.indexOf('=')
  lines[command.line] = `${original.slice(0, separator + 1)}${replacement}`
  const transformed = lines.join('\n')

  const parsed = parseSupervisorConfig(transformed)
  const before = findKlipperProgram(config)
  const after = findKlipperProgram(parsed)
  const preserved = {}
  let otherDirectives = 0
  for (const entry of before.section.entries) {
    if (entry.key === 'command') continue
    const match = after.section.entries.find((item) => item.key === entry.key)
    if (!match || match.value !== entry.value)
      throw diagnostic(
        `transformation changed the ${entry.key} directive`,
        'transform',
      )
    if (PRESERVED_DIRECTIVE_KEYS.includes(entry.key))
      preserved[entry.key] = entry.value
    else otherDirectives += 1
  }
  const otherPrograms = []
  for (const other of config.sections) {
    if (other.type !== 'program' || other === before.section) continue
    const otherCommand = entryValue(other, 'command')
    otherPrograms.push({
      name: other.name,
      commandDigest: otherCommand ? sha256(otherCommand) : null,
    })
    const counterpart = parsed.sections.find(
      (item) => item.type === 'program' && item.name === other.name,
    )
    if (!counterpart)
      throw diagnostic(
        'transformation removed a supervisor program',
        'transform',
      )
    for (const entry of other.entries) {
      const match = counterpart.entries.find((item) => item.key === entry.key)
      if (!match || match.value !== entry.value)
        throw diagnostic(
          `transformation changed the ${entry.key} directive of another program`,
          'transform',
        )
    }
  }

  return {
    text: transformed,
    delta: {
      changedProgram: 'klipper',
      changedKey: 'command',
      interpreter: interpreter.join(' '),
      klippyArguments,
      klipperRoot: root,
      observerPath,
      originalCommandDigest: sha256(command.value),
      transformedCommandDigest: sha256(replacement),
      preserved,
      otherDirectivesPreserved: otherDirectives,
      otherPrograms,
    },
  }
}

/**
 * Resolve where the child process stderr is routed, using only the extracted
 * configuration. Docker logs are used when Supervisor inherits the child's
 * stderr, never as an assumption.
 */
export function resolveStderrRouting(section) {
  const redirect = entryValue(section, 'redirect_stderr')
  const stdoutFile = entryValue(section, 'stdout_logfile')
  const stderrFile = entryValue(section, 'stderr_logfile')
  if (redirect === 'true') {
    if (!isAbsoluteContainerPath(stdoutFile))
      throw diagnostic(
        'redirect_stderr is enabled without a usable stdout_logfile',
        'routing',
      )
    return { kind: 'stdout-file', path: stdoutFile }
  }
  if (stderrFile !== undefined) {
    if (!isAbsoluteContainerPath(stderrFile))
      throw diagnostic('stderr_logfile is not a safe absolute path', 'routing')
    return { kind: 'stderr-file', path: stderrFile }
  }
  return { kind: 'container-stdout', path: null }
}

// ---------------------------------------------------------------------------
// Observer data validation
// ---------------------------------------------------------------------------

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
}

/**
 * Validate the analyzer output of the existing observer. The observer owns the
 * classification; this function only checks the shape and drops unknown fields
 * so that no unvalidated value can reach the report.
 */
export function validateObserverAnalysis(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw diagnostic('observer analysis is not an object', 'analyze')
  if (typeof value.truncated !== 'boolean')
    throw diagnostic('observer analysis has no truncated flag', 'analyze')
  if (!Array.isArray(value.sessions))
    throw diagnostic('observer analysis has no sessions', 'analyze')
  if (value.sessions.length > 4097)
    throw diagnostic('observer analysis exceeds the session bound', 'analyze')
  const sessions = value.sessions.map((session) => {
    if (!session || typeof session !== 'object' || Array.isArray(session))
      throw diagnostic('observer session is not an object', 'analyze')
    if (!Number.isSafeInteger(session.session) || session.session < 1)
      throw diagnostic('observer session has an invalid identity', 'analyze')
    if (!isNonNegativeInteger(session.accepted_bytes))
      throw diagnostic('observer session has invalid accepted bytes', 'analyze')
    if (!isNonNegativeInteger(session.unmatched_responses))
      throw diagnostic(
        'observer session has invalid unmatched responses',
        'analyze',
      )
    for (const flag of [
      'terminal_response',
      'finished',
      'success',
      'started',
      'observer_error',
    ]) {
      if (typeof session[flag] !== 'boolean')
        throw diagnostic(
          `observer session has an invalid ${flag} flag`,
          'analyze',
        )
    }
    if (!session.counters || typeof session.counters !== 'object')
      throw diagnostic('observer session has no counters', 'analyze')
    const counters = {}
    for (const [key, counter] of Object.entries(session.counters)) {
      if (!COUNTER_KEYS.includes(key))
        throw diagnostic('observer session has an unknown counter', 'analyze')
      if (!isNonNegativeInteger(counter))
        throw diagnostic('observer session has an invalid counter', 'analyze')
      counters[key] = counter
    }
    const elapsed = session.last_identify_elapsed
    if (elapsed !== null && elapsed !== undefined) {
      if (!isFiniteNumber(elapsed) || elapsed < 0)
        throw diagnostic(
          'observer session has an invalid identification elapsed time',
          'analyze',
        )
    }
    if (!OBSERVER_CLASSIFICATIONS.includes(session.classification))
      throw diagnostic(
        'observer session has an unknown classification',
        'analyze',
      )
    return {
      session: session.session,
      accepted_bytes: session.accepted_bytes,
      unmatched_responses: session.unmatched_responses,
      terminal_response: session.terminal_response,
      counters,
      finished: session.finished,
      success: session.success,
      started: session.started,
      observer_error: session.observer_error,
      last_identify_elapsed: elapsed ?? null,
      classification: session.classification,
    }
  })
  return { truncated: value.truncated, sessions }
}

/** Read the Klipper source pins from the pinned observer bytes. */
export function readObserverSourcePins(text) {
  const pins = {}
  for (const match of text.matchAll(/"([^"]+)"\s*:\s*"([0-9a-f]{64})"/g)) {
    if (match[1].startsWith('klippy/')) pins[match[1]] = match[2]
  }
  if (Object.keys(pins).length !== 2)
    throw diagnostic(
      'observer source does not declare exactly two klippy source pins',
      'pins',
    )
  return pins
}

// ---------------------------------------------------------------------------
// Container specification
// ---------------------------------------------------------------------------

const FORBIDDEN_ARGUMENTS = [
  '--privileged',
  '--device',
  '--publish',
  '--cap-add',
  '--cap-add-all',
  '--security-opt=seccomp=unconfined',
  '--pid=host',
  '--ipc=host',
  '--network=host',
  '--userns=host',
  '--userns=host-id',
  '--privileged=true',
]

/** Build the exact `docker create` argument vector for the diagnostic container. */
export function buildContainerArguments(options) {
  const arguments_ = [
    'create',
    '--name',
    options.name,
    '--platform',
    options.platform,
    '--pull',
    'never',
    '--network',
    'none',
    '--cpus',
    options.cpus,
    '--memory',
    options.memory,
    '--pids-limit',
    options.pidsLimit,
    '--security-opt',
    'no-new-privileges:true',
    '--tmpfs',
    '/tmp:noexec',
    '--tmpfs',
    '/home/printer/printer_data/comms:noexec',
  ]
  for (const [key, value] of options.labels)
    arguments_.push('--label', `${key}=${value}`)
  arguments_.push('--volume', `${options.volume}:/home/printer/printer_data`)
  arguments_.push(
    '--volume',
    `${options.observerHostPath}:${OBSERVER_MOUNT_PATH}:ro`,
  )
  arguments_.push(
    '--volume',
    `${options.configHostPath}:${options.configContainerPath}:ro`,
  )
  arguments_.push(options.image)
  return arguments_
}

/** Refuse a container specification that widens the isolation of the run. */
export function assertContainerIsolation(arguments_) {
  for (const argument of arguments_) {
    if (FORBIDDEN_ARGUMENTS.includes(argument))
      throw diagnostic(
        `container specification contains a forbidden argument: ${argument}`,
        'isolation',
      )
    if (argument.startsWith('-p') && argument !== '--pull')
      throw diagnostic('container specification publishes a port', 'isolation')
  }
  const network = arguments_.indexOf('--network')
  if (network === -1 || arguments_[network + 1] !== 'none')
    throw diagnostic(
      'container specification is not network isolated',
      'isolation',
    )
  if (!arguments_.includes('--pull'))
    throw diagnostic(
      'container specification does not pin the image',
      'isolation',
    )
  const pull = arguments_.indexOf('--pull')
  if (arguments_[pull + 1] !== 'never')
    throw diagnostic('container specification may pull an image', 'isolation')
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index]
    if (argument !== '--volume') continue
    const value = arguments_[index + 1] ?? ''
    const readOnly = value.endsWith(':ro')
    const source = value.split(':')[0] ?? ''
    const namedVolume = !source.includes('/')
    if (!readOnly && !namedVolume)
      throw diagnostic(
        'container specification mounts a writable host path',
        'isolation',
      )
  }
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

const ENDPOINT_ARGUMENTS = [
  '--host',
  '--hostname',
  '--url',
  '--uri',
  '--endpoint',
  '--port',
  '--publish',
  '--address',
  '--socket',
  '--serial',
  '--device',
  '--network',
  '--printer',
]

/** Validate the runner arguments. No Docker call happens before this passes. */
export function parseArguments(argv) {
  const options = {
    optIn: null,
    ledgerDir: null,
    image: PINNED_IMAGE_REFERENCE,
    platform: PINNED_PLATFORM,
    observationMs: READINESS_BUDGET_MS,
    composeFile: join(REPOSITORY_ROOT, 'infra/sim/docker-compose.yml'),
    observerPath: join(
      REPOSITORY_ROOT,
      'infra/sim/experiments/serial_diagnostic.py',
    ),
  }
  for (const argument of argv) {
    if (argument.startsWith('--opt-in=')) {
      options.optIn = argument.slice('--opt-in='.length)
      continue
    }
    if (argument.startsWith('--ledger-dir=')) {
      options.ledgerDir = argument.slice('--ledger-dir='.length)
      continue
    }
    if (argument.startsWith('--image=')) {
      options.image = argument.slice('--image='.length)
      continue
    }
    if (argument.startsWith('--platform=')) {
      options.platform = argument.slice('--platform='.length)
      continue
    }
    if (argument.startsWith('--observation-ms=')) {
      options.observationMs = Number(argument.slice('--observation-ms='.length))
      continue
    }
    if (argument.startsWith('--compose-file=')) {
      options.composeFile = argument.slice('--compose-file='.length)
      continue
    }
    if (argument.startsWith('--observer=')) {
      options.observerPath = argument.slice('--observer='.length)
      continue
    }
    const name = argument.split('=')[0]
    if (ENDPOINT_ARGUMENTS.includes(name))
      throw diagnostic(`endpoint argument is not allowed: ${name}`, 'arguments')
    throw diagnostic(`unknown argument: ${argument}`, 'arguments')
  }
  if (options.optIn !== OPT_IN_TOKEN)
    throw diagnostic(
      'explicit synthetic opt-in is required: --opt-in=' + OPT_IN_TOKEN,
      'arguments',
    )
  if (options.image !== PINNED_IMAGE_REFERENCE)
    throw diagnostic(
      'image reference does not match the reviewed pinned amd64 image',
      'arguments',
    )
  if (options.platform !== PINNED_PLATFORM)
    throw diagnostic(
      'platform does not match the reviewed amd64 platform',
      'arguments',
    )
  if (
    !Number.isSafeInteger(options.observationMs) ||
    options.observationMs <= 0
  )
    throw diagnostic(
      'observation window is not a positive integer',
      'arguments',
    )
  if (options.observationMs > READINESS_BUDGET_MS)
    throw diagnostic(
      'observation window may not extend the original 90 second readiness budget',
      'arguments',
    )
  if (!isAbsolute(options.composeFile) || !isAbsolute(options.observerPath))
    throw diagnostic('compose and observer paths must be absolute', 'arguments')
  return options
}

// ---------------------------------------------------------------------------
// Docker seam
// ---------------------------------------------------------------------------

/** Real Docker CLI runner. Every call uses an argument vector, never a shell. */
export function createDockerRunner() {
  return {
    async run(args, runOptions = {}) {
      const timeoutMs = runOptions.timeoutMs ?? DOCKER_CALL_TIMEOUT_MS
      const maxBuffer = runOptions.maxBuffer ?? 8 * 1024 * 1024
      return new Promise((resolvePromise) => {
        const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] })
        const stdout = []
        const stderr = []
        let settled = false
        const finish = (result) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolvePromise(result)
        }
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          finish({
            status: null,
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: 'docker call exceeded its time limit',
            timedOut: true,
          })
        }, timeoutMs)
        child.stdout.on('data', (chunk) => {
          if (Buffer.concat(stdout).length < maxBuffer) stdout.push(chunk)
        })
        child.stderr.on('data', (chunk) => {
          if (Buffer.concat(stderr).length < maxBuffer) stderr.push(chunk)
        })
        child.on('error', (error) => {
          finish({
            status: null,
            stdout: '',
            stderr: error.message,
            timedOut: false,
          })
        })
        child.on('close', (status) => {
          finish({
            status,
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
            timedOut: false,
          })
        })
        if (runOptions.input !== undefined) child.stdin.end(runOptions.input)
        else child.stdin.end()
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function readBoundedFile(path, limit) {
  const content = readFileSync(path)
  if (content.length > limit)
    throw diagnostic('extracted file exceeds the permitted size', 'discover')
  return content.toString('utf8')
}

function writeLedgerFile(ledgerDir, name, content) {
  const path = join(ledgerDir, name)
  writeFileSync(path, content)
  return path
}

async function dockerRun(docker, args, runOptions, phase) {
  const result = await docker.run(args, runOptions)
  if (result.timedOut)
    throw diagnostic(`docker ${args[0]} call timed out`, phase)
  if (result.status !== 0)
    throw diagnostic(
      `docker ${args[0]} failed with status ${result.status}`,
      phase,
    )
  return result
}

async function dockerJson(docker, args, runOptions, phase) {
  const result = await dockerRun(docker, args, runOptions, phase)
  try {
    return JSON.parse(result.stdout)
  } catch (cause) {
    throw diagnostic(`docker ${args[0]} returned unreadable JSON`, phase, cause)
  }
}

async function copyOut(docker, container, path, destination, phase) {
  await dockerRun(
    docker,
    ['cp', `${container}:${path}`, destination],
    {},
    phase,
  )
  return destination
}

function digestOfFile(path) {
  return sha256(readFileSync(path))
}

function verifyComposePin(composeFile) {
  if (!existsSync(composeFile))
    throw diagnostic('compose file is missing', 'preflight')
  const text = readFileSync(composeFile, 'utf8')
  if (!text.includes(PINNED_AMD64_DIGEST))
    throw diagnostic(
      'compose file does not pin the reviewed amd64 image digest',
      'preflight',
    )
  if (!text.includes(`platform: ${PINNED_PLATFORM}`))
    throw diagnostic(
      'compose file does not pin the reviewed amd64 platform',
      'preflight',
    )
  return sha256(text)
}

function verifyObserverSource(observerPath) {
  if (!existsSync(observerPath))
    throw diagnostic('observer source is missing', 'preflight')
  const digest = digestOfFile(observerPath)
  if (digest !== OBSERVER_SOURCE_SHA256)
    throw diagnostic(
      'observer source does not match the reviewed source hash',
      'preflight',
    )
  const pins = readObserverSourcePins(readFileSync(observerPath, 'utf8'))
  return { digest, pins }
}

function supervisorConfigPathFromScript(script) {
  for (const line of script.split('\n')) {
    const match = /supervisord\b[^\n]*/.exec(line)
    if (!match) continue
    const segment = match[0]
    const explicit = /(?:-c|--configuration-file(?:=|\s))\s*"?([^"\s]+)"?/.exec(
      segment,
    )
    if (explicit) return explicit[1]
    const candidate =
      /"?'?([A-Za-z0-9_@%+=:,./-]*supervisord[A-Za-z0-9_@%+=:,./-]*\.conf)'?"?/.exec(
        segment,
      )
    if (candidate) return candidate[1]
  }
  return null
}

async function discoverSupervisorConfig(docker, options, state) {
  const inspectionName = `${state.runName}-inspect`
  state.inspectionName = inspectionName
  state.resources.push({ kind: 'container', name: inspectionName })
  await dockerRun(
    docker,
    [
      'create',
      '--name',
      inspectionName,
      '--platform',
      options.platform,
      '--pull',
      'never',
      ...state.labelArguments,
      options.image,
    ],
    {},
    'discover',
  )
  const inspected = await dockerJson(
    docker,
    ['inspect', inspectionName],
    {},
    'discover',
  )
  const container = Array.isArray(inspected) ? inspected[0] : inspected
  const imageConfig = container?.Config ?? {}
  const candidates = [
    ...(Array.isArray(imageConfig.Entrypoint) ? imageConfig.Entrypoint : []),
    ...(Array.isArray(imageConfig.Cmd) ? imageConfig.Cmd : []),
  ].filter((value) => typeof value === 'string' && value.startsWith('/'))
  let script = null
  for (const [index, candidate] of candidates.entries()) {
    const destination = join(state.workDir, `entrypoint-${index}`)
    const result = await docker.run([
      'cp',
      `${inspectionName}:${candidate}`,
      destination,
    ])
    if (result.status === 0 && existsSync(destination)) {
      script = readBoundedFile(destination, ENTRYPOINT_SCRIPT_BYTE_LIMIT)
      break
    }
  }
  if (script === null)
    throw diagnostic(
      'image entrypoint script could not be extracted from the pinned image',
      'discover',
    )
  const configPath = supervisorConfigPathFromScript(script)
  if (!configPath)
    throw diagnostic(
      'supervisor configuration path could not be derived from the image entrypoint',
      'discover',
    )
  const configDestination = join(state.workDir, 'supervisord.conf')
  const copied = await docker.run([
    'cp',
    `${inspectionName}:${configPath}`,
    configDestination,
  ])
  if (copied.status !== 0 || !existsSync(configDestination))
    throw diagnostic(
      'supervisor configuration could not be extracted read-only from the pinned image',
      'discover',
    )
  const configText = readBoundedFile(
    configDestination,
    SUPERVISOR_CONFIG_BYTE_LIMIT,
  )
  return { configPath, configText }
}

async function verifyKlipperSources(docker, state, root, pins) {
  const verified = []
  for (const [relative, expected] of Object.entries(pins)) {
    const destination = join(state.workDir, relative.replaceAll('/', '_'))
    const result = await docker.run([
      'cp',
      `${state.inspectionName}:${root}/${relative}`,
      destination,
    ])
    if (result.status !== 0 || !existsSync(destination))
      throw diagnostic(
        `klipper source ${relative} could not be extracted from the pinned image`,
        'discover',
      )
    const digest = digestOfFile(destination)
    if (digest !== expected)
      throw diagnostic(
        `klipper source ${relative} does not match its reviewed hash`,
        'discover',
      )
    verified.push({ file: relative, sha256: digest })
  }
  return verified
}

async function readSupervisorStatus(docker, container) {
  const result = await docker.run([
    'exec',
    container,
    'supervisorctl',
    'status',
  ])
  const states = {}
  const pids = {}
  if (result.status !== 0) return { states, pids }
  for (const line of result.stdout.split('\n')) {
    const match = /^([A-Za-z0-9_-]+)\s+([A-Z]+)(?:\s+pid\s+(\d+))?/.exec(
      line.trim(),
    )
    if (!match) continue
    if (!SUPERVISOR_PROGRAMS.includes(match[1])) continue
    states[match[1]] = match[2]
    if (match[3]) pids[match[1]] = Number(match[3])
  }
  return { states, pids }
}

async function readProcessCommand(docker, container, pid) {
  const result = await docker.run([
    'exec',
    container,
    'cat',
    `/proc/${pid}/cmdline`,
  ])
  if (result.status !== 0) return []
  return result.stdout
    .split('\0')
    .filter((value) => value.length > 0)
    .map((value) => value.trim())
}

function tailBytes(text, limit) {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= limit) return bytes.toString('utf8')
  return bytes.subarray(bytes.length - limit).toString('utf8')
}

async function captureChildStderr(docker, container, routing, limit) {
  if (routing.kind === 'container-stdout') {
    const result = await docker.run(['logs', '--tail', '5000', container])
    if (result.status !== 0) return { available: false, text: '', routing }
    return {
      available: true,
      text: tailBytes(result.stdout, limit),
      routing,
    }
  }
  const result = await docker.run([
    'exec',
    container,
    'tail',
    '-c',
    String(limit),
    routing.path,
  ])
  if (result.status !== 0) return { available: false, text: '', routing }
  return { available: true, text: tailBytes(result.stdout, limit), routing }
}

async function analyzeCapture(docker, container, capture) {
  const result = await docker.run(
    ['exec', '-i', container, 'python3', OBSERVER_MOUNT_PATH, 'analyze'],
    { input: capture.text },
  )
  if (result.status !== 0)
    throw diagnostic('observer analysis failed inside the container', 'analyze')
  let parsed
  try {
    parsed = JSON.parse(result.stdout)
  } catch (cause) {
    throw diagnostic(
      'observer analysis returned unreadable JSON',
      'analyze',
      cause,
    )
  }
  return validateObserverAnalysis(parsed)
}

async function removeOwned(docker, state) {
  if (state.cleanupDone) return state.cleanupErrors
  state.cleanupDone = true
  const failures = []
  for (const resource of state.resources) {
    try {
      if (resource.kind === 'container') {
        const labels = await dockerJson(
          docker,
          ['inspect', '--format', '{{json .Config.Labels}}', resource.name],
          {},
          'cleanup',
        )
        const parsed = typeof labels === 'string' ? JSON.parse(labels) : labels
        if (!parsed || parsed[state.labelKey] !== state.runId)
          throw new Error('label verification failed')
        await dockerRun(docker, ['rm', '-f', resource.name], {}, 'cleanup')
      } else if (resource.kind === 'volume') {
        const labels = await dockerJson(
          docker,
          ['volume', 'inspect', '--format', '{{json .Labels}}', resource.name],
          {},
          'cleanup',
        )
        const parsed = typeof labels === 'string' ? JSON.parse(labels) : labels
        if (!parsed || parsed[state.labelKey] !== state.runId)
          throw new Error('label verification failed')
        await dockerRun(docker, ['volume', 'rm', resource.name], {}, 'cleanup')
      }
    } catch (error) {
      failures.push({
        kind: resource.kind,
        name: resource.name,
        message: error.message,
      })
    }
  }
  state.cleanupErrors = failures
  return failures
}

function removeWorkDirectory(state) {
  if (!state.workDir) return
  try {
    rmSync(state.workDir, { recursive: true, force: true })
  } catch {
    // The external ledger keeps the diagnostic evidence; the temporary
    // directory is disposable and its failure is reported by the caller.
  }
}

function assertLedgerOutsideRepository(ledgerDir) {
  const relation = relative(REPOSITORY_ROOT, ledgerDir)
  if (relation === '' || (!relation.startsWith('..') && !isAbsolute(relation)))
    throw diagnostic(
      'ledger directory must stay outside the repository',
      'preflight',
    )
}

/**
 * Run the diagnostic. The function never throws raw Docker output and always
 * cleans up the resources this run created, independently of one another.
 */
export async function runDiagnostic(options) {
  const docker = options.docker
  const clock = options.clock ?? { now: () => Date.now() }
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const composeFile =
    options.composeFile ?? join(REPOSITORY_ROOT, 'infra/sim/docker-compose.yml')
  const observerPath =
    options.observerPath ??
    join(REPOSITORY_ROOT, 'infra/sim/experiments/serial_diagnostic.py')
  const image = options.image ?? PINNED_IMAGE_REFERENCE
  const platform = options.platform ?? PINNED_PLATFORM
  const observationMs = options.observationMs ?? READINESS_BUDGET_MS
  const settings = { composeFile, observerPath, image, platform, observationMs }
  const runId = options.runId
  const state = {
    runName: options.runName,
    runId,
    labelKey: 'com.open3dfarmmanager.identify-diagnostic',
    labelArguments: [
      '--label',
      `com.open3dfarmmanager.identify-diagnostic=${runId}`,
      '--label',
      `com.open3dfarmmanager.identify-diagnostic-run=${options.runName}`,
    ],
    resources: [],
    workDir: null,
    cleanupDone: false,
    cleanupErrors: [],
    phase: 'preflight',
  }

  let ledgerDir = options.ledgerDir
  if (!ledgerDir) {
    ledgerDir = mkdtempSync(join(tmpdir(), 'open3dfm-identify-diagnostic-'))
  }
  mkdirSync(ledgerDir, { recursive: true })
  assertLedgerOutsideRepository(resolve(ledgerDir))
  state.workDir = join(ledgerDir, 'work')
  mkdirSync(state.workDir, { recursive: true })

  try {
    // Phase: preflight ---------------------------------------------------
    const composeDigest = verifyComposePin(settings.composeFile)
    const observer = verifyObserverSource(settings.observerPath)
    const pinnedImage = settings.image

    // Phase: baseline ----------------------------------------------------
    state.phase = 'baseline'
    const baseline = []
    for (const [name, args] of [
      ['containers', ['ps', '-a', '--no-trunc']],
      ['images', ['images', '--digests', '--no-trunc']],
      ['volumes', ['volume', 'ls']],
      ['networks', ['network', 'ls']],
      ['disk', ['system', 'df']],
    ]) {
      const result = await docker.run(args)
      baseline.push(`# ${name}\n${result.stdout}${result.stderr}`)
    }
    writeLedgerFile(
      ledgerDir,
      'baseline.txt',
      `run=${state.runName}\nimage=${pinnedImage}\n${baseline.join('\n')}`,
    )

    // Phase: discover ----------------------------------------------------
    state.phase = 'discover'
    const discovered = await discoverSupervisorConfig(docker, settings, state)
    writeLedgerFile(
      ledgerDir,
      'supervisord.original.conf',
      discovered.configText,
    )
    writeLedgerFile(
      ledgerDir,
      'NOTICE.txt',
      [
        'The extracted Supervisor configuration belongs to',
        'ghcr.io/mainsail-crew/virtual-klipper-printer and stays under its',
        'original GPL-3.0 licence. It is retained outside the repository and',
        'is never committed.',
        `source reference: ${pinnedImage}`,
        `configuration path in image: ${discovered.configPath}`,
        `configuration sha256: ${sha256(discovered.configText)}`,
      ].join('\n'),
    )

    // Phase: transform ---------------------------------------------------
    state.phase = 'transform'
    const transformed = transformSupervisorConfig(discovered.configText, {
      observerPath: OBSERVER_MOUNT_PATH,
    })
    writeLedgerFile(ledgerDir, 'supervisord.transformed.conf', transformed.text)
    const transformedPath = join(state.workDir, 'supervisord.transformed.conf')
    writeFileSync(transformedPath, transformed.text)

    // Phase: source gate -------------------------------------------------
    // The pins come from the pinned observer bytes. The resolver is a test
    // seam only; the command line never overrides it.
    const sourcePins = options.resolveSourcePins
      ? options.resolveSourcePins()
      : observer.pins
    const verifiedSources = await verifyKlipperSources(
      docker,
      state,
      transformed.delta.klipperRoot,
      sourcePins,
    )

    // Phase: observe -----------------------------------------------------
    state.phase = 'observe'
    const volumeName = `${state.runName}-data`
    state.resources.push({ kind: 'volume', name: volumeName })
    await dockerRun(
      docker,
      ['volume', 'create', ...state.labelArguments, volumeName],
      {},
      'observe',
    )
    const containerName = state.runName
    state.resources.push({ kind: 'container', name: containerName })
    const containerArguments = buildContainerArguments({
      name: containerName,
      platform: settings.platform,
      image: pinnedImage,
      cpus: '2.0',
      memory: '1g',
      pidsLimit: '256',
      labels: [
        [state.labelKey, runId],
        ['com.open3dfarmmanager.identify-diagnostic-run', state.runName],
      ],
      volume: volumeName,
      observerHostPath: settings.observerPath,
      configHostPath: transformedPath,
      configContainerPath: discovered.configPath,
    })
    assertContainerIsolation(containerArguments)
    await dockerRun(docker, containerArguments, {}, 'observe')
    await dockerRun(docker, ['start', containerName], {}, 'observe')

    const startedAt = clock.now()
    const deadline = startedAt + settings.observationMs
    while (clock.now() < deadline) {
      const status = await docker.run([
        'inspect',
        '--format',
        '{{.State.Status}}',
        containerName,
      ])
      if (status.status !== 0) break
      if (status.stdout.trim() === 'exited') break
      await sleep(Math.min(1000, Math.max(0, deadline - clock.now())))
    }
    const observedFor = clock.now() - startedAt

    // Phase: verification ------------------------------------------------
    state.phase = 'verify'
    const supervisor = await readSupervisorStatus(docker, containerName)
    const processes = supervisor.states
    let wrapperApplied = false
    const klipperPid = supervisor.pids.klipper
    if (klipperPid) {
      const command = await readProcessCommand(
        docker,
        containerName,
        klipperPid,
      )
      wrapperApplied =
        command.includes(OBSERVER_MOUNT_PATH) && command.includes('observe')
    }

    // Phase: capture -----------------------------------------------------
    state.phase = 'capture'
    const program = findKlipperProgram(
      parseSupervisorConfig(discovered.configText),
    ).section
    const routing = resolveStderrRouting(program)
    writeLedgerFile(
      ledgerDir,
      'paths.txt',
      `configuration=${discovered.configPath}\nrouting=${routing.path ?? 'container-stdout'}\n`,
    )
    const capture = await captureChildStderr(
      docker,
      containerName,
      routing,
      CAPTURE_BYTE_LIMIT,
    )
    writeLedgerFile(
      ledgerDir,
      'child-stderr.log',
      capture.available ? capture.text : '',
    )
    const observerRecords = capture.text
      .split('\n')
      .filter((line) => line.startsWith(OBSERVER_PREFIX)).length

    // Phase: analyze -----------------------------------------------------
    state.phase = 'analyze'
    let analysis = null
    let analysisError = null
    if (capture.available && observerRecords > 0) {
      try {
        analysis = await analyzeCapture(docker, containerName, capture)
      } catch (error) {
        analysisError = error.message
      }
    }

    // Phase: report ------------------------------------------------------
    state.phase = 'report'
    const inspected = await dockerJson(
      docker,
      ['inspect', '--format', '{{json .State}}', containerName],
      {},
      'report',
    )
    const containerState =
      typeof inspected === 'string' ? JSON.parse(inspected) : inspected
    const result = {
      schema: 'open3dfarmmanager.simulator-identify-diagnostic.v1',
      run: state.runName,
      image: pinnedImage,
      platform: settings.platform,
      observer: {
        sourceSha256: observer.digest,
        mountPath: OBSERVER_MOUNT_PATH,
      },
      pin: {
        composeSha256: composeDigest,
        imageDigest: PINNED_AMD64_DIGEST,
      },
      sources: verifiedSources,
      configuration: {
        pathDigest: sha256(discovered.configPath),
        originalSha256: sha256(discovered.configText),
        transformedSha256: sha256(transformed.text),
        delta: transformed.delta,
      },
      container: {
        isolation: {
          network: 'none',
          publishedPorts: 0,
          privileged: false,
          devices: 0,
          cpus: '2.0',
          memory: '1g',
          pidsLimit: '256',
          noexecTmpfs: true,
          imagePulled: false,
        },
        state: containerState?.Status ?? 'unavailable',
        exitCode: containerState?.ExitCode ?? null,
        oomKilled: containerState?.OOMKilled ?? null,
      },
      observation: {
        budgetMs: READINESS_BUDGET_MS,
        windowMs: settings.observationMs,
        observedMs: observedFor,
        exceededBudget: observedFor > READINESS_BUDGET_MS,
      },
      routing: {
        kind: routing.kind,
        pathDigest: routing.path ? sha256(routing.path) : null,
      },
      capture: {
        available: capture.available,
        reason: !capture.available
          ? 'capture-unavailable'
          : observerRecords > 0
            ? 'observer-records-captured'
            : 'no-observer-records',
        bytes: Buffer.byteLength(capture.text, 'utf8'),
        limitBytes: CAPTURE_BYTE_LIMIT,
        observerRecords,
        truncated:
          Buffer.byteLength(capture.text, 'utf8') >= CAPTURE_BYTE_LIMIT,
      },
      wrapperApplied,
      processes,
      observerAnalysis: analysis,
      observerAnalysisError: analysisError,
      readiness: 'not-evaluated',
      conclusion:
        'diagnostic-only observation; no readiness acceptance and no retry',
      ledger: ledgerDir,
    }
    writeLedgerFile(ledgerDir, 'result.json', JSON.stringify(result, null, 2))
    const cleanupErrors = await removeOwned(docker, state)
    removeWorkDirectory(state)
    result.cleanup = {
      errors: cleanupErrors,
      completed: cleanupErrors.length === 0,
    }
    writeLedgerFile(ledgerDir, 'result.json', JSON.stringify(result, null, 2))
    if (cleanupErrors.length > 0) {
      const cleanupFailure = new DiagnosticError('cleanup did not complete', {
        phase: 'cleanup',
        cleanupErrors,
      })
      cleanupFailure.result = result
      throw cleanupFailure
    }
    return result
  } catch (error) {
    const cleanupErrors = await removeOwned(docker, state)
    removeWorkDirectory(state)
    if (error instanceof DiagnosticError) {
      error.cleanupErrors = cleanupErrors
      throw error
    }
    throw new DiagnosticError(error.message, {
      phase: state.phase,
      cause: error,
      cleanupErrors,
    })
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ error: error.message, phase: error.phase })}\n`,
    )
    return 2
  }
  const runId = createHash('sha256')
    .update(`${process.pid}:${Date.now()}:${Math.random()}`)
    .digest('hex')
    .slice(0, 16)
  const runName = `open3dfm-identify-${runId}`
  try {
    const result = await runDiagnostic({
      ...options,
      docker: createDockerRunner(),
      runId,
      runName,
    })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return 0
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        error: error.message,
        phase: error.phase ?? 'unknown',
        cleanupErrors: error.cleanupErrors ?? [],
      })}\n`,
    )
    return 1
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
