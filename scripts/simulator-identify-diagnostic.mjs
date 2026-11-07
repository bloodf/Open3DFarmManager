#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Opt-in, bounded identification diagnostic for the pinned synthetic simulator.
//
// The runner is a diagnostic instrument, not a gate. It never reports readiness,
// never retries a failed run and never promotes a result to a CI pass. It reuses
// the existing observer unchanged and emits only validated observer data plus
// process lifecycle metadata.
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path'
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
export const CHILD_LOG_DIRECTORY_LIMIT = 64
export const CHILD_LOG_FILE_LIMIT = 8
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
export const ROUTING_KINDS = [
  'stdout-file',
  'stderr-file',
  'child-log',
  'container-output',
  'unresolved',
]
export const CAPTURE_REASONS = [
  'observer-records-captured',
  'no-observer-records',
  'capture-unavailable',
  'routing-unresolved',
  'wrapper-not-applied',
]
export const WRAPPER_REASONS = [
  'observer-in-command',
  'observer-absent-from-command',
  'supervisor-unavailable',
  'program-not-running',
  'command-unreadable',
]
export const STAGES = [
  'preflight',
  'baseline',
  'discover',
  'transform',
  'sources',
  'observe',
  'verify',
  'capture',
  'analyze',
  'report',
  'cleanup',
]

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url))
export const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, '..')
const KLIPPY_SCRIPT_SUFFIX = '/klippy/klippy.py'
const SHELL_METACHARACTERS = /[;&|<>`$(){}\[\]!*?\\\n\r]/
const LABEL_KEY = 'com.open3dfarmmanager.identify-diagnostic'
const LABEL_RUN_KEY = 'com.open3dfarmmanager.identify-diagnostic-run'
const DEFAULT_DOCKER_BINARY = 'docker'
const CONTAINER_LOG_LINE_LIMIT = 5000
const STARTUP_OUTPUT_LIMIT = 64 * 1024
const STARTUP_OUTPUT_TIMEOUT_MS = 2000

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
    const standardRpcFactory =
      current?.type === 'rpcinterface' &&
      current.name === 'supervisor' &&
      key === 'supervisor.rpcinterface_factory'
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !standardRpcFactory)
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

/** Return the single `[supervisord]` server section, when the file has one. */
export function findSupervisorServerSection(config) {
  const servers = config.sections.filter(
    (section) => section.type === 'supervisord',
  )
  if (servers.length !== 1) return null
  return servers[0]
}

function entryValue(section, key) {
  if (!section) return undefined
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
    // The pinned Dockerfile declares this exact venv with `virtualenv -p python3`.
    const executable =
      /^(?:\/usr\/bin\/)?python3(?:\.\d+)?$/.test(token) ||
      token === '/home/printer/python-env/bin/python'
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
 * configuration.
 *
 * Supervisor decides with `redirect_stderr`. When the directive is present the
 * decision is taken from it. When the directive is absent both branches stay
 * possible, so both are returned as candidates and the capture decides by
 * content, never by assumption.
 *
 * The routing is never a reason to abort the run: an unusable routing is
 * reported as `unresolved` and costs the capture, not the observation.
 */
export function resolveStderrRouting(programSection, serverSection = null) {
  const redirectRaw = entryValue(programSection, 'redirect_stderr')
  const stdoutFile = entryValue(programSection, 'stdout_logfile')
  const stderrFile = entryValue(programSection, 'stderr_logfile')
  const childlogdir = entryValue(serverSection, 'childlogdir')
  const redirect =
    redirectRaw === undefined
      ? null
      : redirectRaw.trim().toLowerCase() === 'true'
  const branches =
    redirect === null ? ['true', 'false'] : [redirect ? 'true' : 'false']
  const candidates = []
  const rejected = []
  const pushFile = (kind, path) => {
    if (!isAbsoluteContainerPath(path)) {
      rejected.push(`${path} is not a safe absolute container path`)
      return
    }
    if (path.startsWith('/dev/')) {
      // A device target is the container's own stream, not a file to tail.
      candidates.push({ kind: 'container-output', path: null })
      return
    }
    candidates.push({ kind, path })
  }
  for (const branch of branches) {
    if (branch === 'true') {
      if (stdoutFile !== undefined) {
        pushFile('stdout-file', stdoutFile)
      } else {
        candidates.push({
          kind: 'child-log',
          path: null,
          childlogdir: isAbsoluteContainerPath(childlogdir ?? '')
            ? childlogdir
            : null,
        })
      }
    } else if (stderrFile !== undefined) {
      pushFile('stderr-file', stderrFile)
    } else {
      candidates.push({ kind: 'container-output', path: null })
    }
  }
  if (candidates.length === 0)
    return {
      kind: 'unresolved',
      path: null,
      candidates: [],
      ambiguous: redirect === null,
      reason: rejected.join('; ') || 'no usable capture source',
    }
  return {
    kind: candidates[0].kind,
    path: candidates[0].path ?? null,
    candidates,
    ambiguous: redirect === null,
    reason: null,
  }
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

const FORBIDDEN_OPTION_NAMES = [
  '--privileged',
  '--device',
  '--publish',
  '--cap-add',
  '--cap-add-all',
  '--pid',
  '--ipc',
  '--userns',
]
const FORBIDDEN_OPTION_VALUES = {
  '--pid': ['host'],
  '--ipc': ['host'],
  '--userns': ['host', 'host-id'],
}
const ALLOWED_SECURITY_OPTIONS = ['no-new-privileges:true']

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
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index]
    const separator = argument.indexOf('=')
    const name = separator === -1 ? argument : argument.slice(0, separator)
    const inlineValue = separator === -1 ? null : argument.slice(separator + 1)
    const value = inlineValue ?? arguments_[index + 1] ?? null
    if (FORBIDDEN_OPTION_NAMES.includes(name))
      throw diagnostic(
        `container specification contains a forbidden argument: ${name}`,
        'isolation',
      )
    const forbiddenValues = FORBIDDEN_OPTION_VALUES[name]
    if (forbiddenValues && value !== null && forbiddenValues.includes(value))
      throw diagnostic(
        `container specification contains a forbidden argument: ${name}=${value}`,
        'isolation',
      )
    if (
      name === '--security-opt' &&
      value !== null &&
      !ALLOWED_SECURITY_OPTIONS.includes(value)
    )
      throw diagnostic(
        'container specification contains a forbidden security option',
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

/**
 * Validate the run settings. The command line and the programmatic entry point
 * share this single source of truth, so a programmatic caller cannot create an
 * unpinned container or observe longer than the readiness budget.
 */
export function assertRunSettings(settings, phase = 'arguments') {
  if (settings.image !== PINNED_IMAGE_REFERENCE)
    throw diagnostic(
      'image reference does not match the reviewed pinned amd64 image',
      phase,
    )
  if (settings.platform !== PINNED_PLATFORM)
    throw diagnostic(
      'platform does not match the reviewed amd64 platform',
      phase,
    )
  if (
    !Number.isSafeInteger(settings.observationMs) ||
    settings.observationMs <= 0
  )
    throw diagnostic('observation window is not a positive integer', phase)
  if (settings.observationMs > READINESS_BUDGET_MS)
    throw diagnostic(
      'observation window may not extend the original 90 second readiness budget',
      phase,
    )
  if (!isAbsolute(settings.composeFile) || !isAbsolute(settings.observerPath))
    throw diagnostic('compose and observer paths must be absolute', phase)
  return settings
}

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
  return assertRunSettings(options, 'arguments')
}

// ---------------------------------------------------------------------------
// Docker seam
// ---------------------------------------------------------------------------

/** Real Docker CLI runner. Every call uses an argument vector, never a shell. */
export function createDockerRunner(options = {}) {
  const binary = options.binary ?? DEFAULT_DOCKER_BINARY
  return {
    async run(args, runOptions = {}) {
      const timeoutMs = runOptions.timeoutMs ?? DOCKER_CALL_TIMEOUT_MS
      const maxBuffer = runOptions.maxBuffer ?? 8 * 1024 * 1024
      return new Promise((resolvePromise) => {
        const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] })
        const stdout = []
        const stderr = []
        let stdoutBytes = 0
        let stderrBytes = 0
        let settled = false
        let failure = null
        const finish = (result) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolvePromise(result)
        }
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          failure ??= {
            status: null,
            stdout: '',
            stderr: 'docker call exceeded its time limit',
            timedOut: true,
          }
        }, timeoutMs)
        child.stdout.on('data', (chunk) => {
          if (stdoutBytes >= maxBuffer) return
          const bounded = chunk.subarray(0, maxBuffer - stdoutBytes)
          stdoutBytes += bounded.length
          stdout.push(bounded)
        })
        child.stderr.on('data', (chunk) => {
          if (stderrBytes >= maxBuffer) return
          const bounded = chunk.subarray(0, maxBuffer - stderrBytes)
          stderrBytes += bounded.length
          stderr.push(bounded)
        })
        child.on('error', (error) => {
          failure ??= {
            status: null,
            stdout: '',
            stderr: error.message,
            timedOut: false,
          }
        })
        child.stdin.on('error', () => {
          // Stream errors do not reach the ChildProcess error listener.
          failure ??= {
            status: null,
            stdout: '',
            stderr: 'docker stdin write failed',
            timedOut: false,
            stdinFailed: true,
          }
          child.kill('SIGKILL')
        })
        child.on('close', (status) => {
          finish(
            failure ?? {
              status,
              stdout: Buffer.concat(stdout).toString('utf8'),
              stderr: Buffer.concat(stderr).toString('utf8'),
              timedOut: false,
            },
          )
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

function readBoundedText(path, limit) {
  const content = readFileSync(path)
  if (content.length > limit)
    return {
      ok: false,
      reason: `exceeds the permitted size of ${limit} bytes`,
      bytes: content.length,
    }
  if (content.includes(0))
    return { ok: false, reason: 'is not a text file', bytes: content.length }
  return { ok: true, text: content.toString('utf8'), bytes: content.length }
}

function writeLedgerFile(ledgerDir, name, content) {
  const path = join(ledgerDir, name)
  writeFileSync(path, content, { mode: 0o600, flag: 'wx' })
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

function digestOfFile(path) {
  return sha256(readFileSync(path))
}

function verifyComposePin(composeFile) {
  if (!existsSync(composeFile))
    throw diagnostic('compose file is missing', 'preflight')
  const text = readFileSync(composeFile, 'utf8')
  const images = [...text.matchAll(/^[ \t]*image:[ \t]*(\S+)[ \t]*$/gm)].map(
    (match) => match[1],
  )
  if (!images.includes(PINNED_IMAGE_REFERENCE))
    throw diagnostic(
      'compose file does not pin the reviewed amd64 image digest',
      'preflight',
    )
  const platforms = [
    ...text.matchAll(/^[ \t]*platform:[ \t]*(\S+)[ \t]*$/gm),
  ].map((match) => match[1])
  if (!platforms.includes(PINNED_PLATFORM))
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

function supervisorConfigPathsFromScript(script, imageConfig) {
  const lines = script
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
  const launches = lines.filter((line) => /\bsupervisord\b/.test(line))
  if (launches.length !== 1) return []
  const launch = launches[0]
  let tokens
  try {
    tokens = parseSupervisorCommand(launch).tokens
  } catch {
    return []
  }
  if (tokens[0] === 'exec') tokens.shift()
  if (!/^(?:\/usr\/(?:local\/)?bin\/)?supervisord$/.test(tokens[0] ?? ''))
    return []
  const reviewedScript =
    sha256(script) ===
    '4b2fac02b4c399495b2f908e11289635121286ead321e30cf297293f0ee651ee'
  if (!reviewedScript && lines.length !== 1) return []
  if (tokens.length === 3 && tokens[1] === '-c') return [tokens[2]]
  if (tokens.length === 2 && tokens[1].startsWith('--configuration='))
    return [tokens[1].slice('--configuration='.length)]
  if (tokens.length === 3 && tokens[1] === '--configuration') return [tokens[2]]
  // The reviewed script changes to ~, which equals this image's working directory.
  if (
    tokens.length !== 1 ||
    tokens[0] !== '/usr/bin/supervisord' ||
    imageConfig.WorkingDir !== '/home/printer'
  )
    return []
  // Supervisor 4.2.5 Options.searchpaths, with /usr/bin and /home/printer.
  // Probe every bounded candidate and refuse multiple files rather than guessing.
  return [
    '/usr/etc/supervisord.conf',
    '/usr/supervisord.conf',
    '/home/printer/supervisord.conf',
    '/home/printer/etc/supervisord.conf',
    '/etc/supervisord.conf',
    '/etc/supervisor/supervisord.conf',
  ]
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
  const rejected = []
  let script = null
  for (const [index, candidate] of candidates.entries()) {
    const destination = join(state.workDir, `entrypoint-${index}`)
    const result = await docker.run([
      'cp',
      `${inspectionName}:${candidate}`,
      destination,
    ])
    if (result.status !== 0 || !existsSync(destination)) {
      rejected.push(`${candidate}: not a readable file in the image`)
      continue
    }
    const bounded = readBoundedText(destination, ENTRYPOINT_SCRIPT_BYTE_LIMIT)
    if (!bounded.ok) {
      rejected.push(`${candidate}: ${bounded.reason}`)
      rmSync(destination, { force: true })
      continue
    }
    script = bounded.text
    break
  }
  if (script === null)
    throw diagnostic(
      `image entrypoint script could not be extracted from the pinned image (rejected candidates: ${
        rejected.join('; ') || 'none'
      })`,
      'discover',
    )
  const configPaths = supervisorConfigPathsFromScript(script, imageConfig)
  if (
    configPaths.length === 0 ||
    configPaths.some((path) => !isAbsoluteContainerPath(path))
  )
    throw diagnostic(
      'absolute supervisor configuration path could not be derived from the image entrypoint',
      'discover',
    )
  const configDestination = join(state.workDir, 'supervisord.conf')
  const found = []
  for (const [index, path] of configPaths.entries()) {
    const destination = join(state.workDir, `config-candidate-${index}`)
    const copied = await docker.run([
      'cp',
      `${inspectionName}:${path}`,
      destination,
    ])
    if (
      copied.status !== 0 &&
      !/no such file|Could not find the file/i.test(copied.stderr ?? '')
    )
      throw diagnostic(
        'supervisor configuration candidate could not be inspected read-only',
        'discover',
      )
    if (copied.status === 0 && existsSync(destination)) {
      const bounded = readBoundedText(destination, SUPERVISOR_CONFIG_BYTE_LIMIT)
      if (!bounded.ok)
        throw diagnostic(
          `supervisor configuration ${bounded.reason}`,
          'discover',
        )
      found.push({ path, text: bounded.text })
    }
  }
  if (found.length !== 1)
    throw diagnostic(
      'supervisor configuration discovery requires exactly one readable candidate',
      'discover',
    )
  const configPath = found[0].path
  writeFileSync(configDestination, found[0].text, { mode: 0o600, flag: 'wx' })
  const configText = readBoundedText(
    configDestination,
    SUPERVISOR_CONFIG_BYTE_LIMIT,
  )
  if (!configText.ok)
    throw diagnostic(
      `supervisor configuration ${configText.reason}`,
      'discover',
    )
  return { configPath, configText: configText.text }
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
  if (result.status !== 0)
    return { available: false, states: {}, pids: {}, reason: 'status-refused' }
  for (const line of result.stdout.split('\n')) {
    const match = /^([A-Za-z0-9_-]+)\s+([A-Z]+)(?:\s+pid\s+(\d+))?/.exec(
      line.trim(),
    )
    if (!match) continue
    if (!SUPERVISOR_PROGRAMS.includes(match[1])) continue
    states[match[1]] = match[2]
    if (match[3]) pids[match[1]] = Number(match[3])
  }
  return { available: true, states, pids, reason: null }
}

async function readProcessCommand(docker, container, pid) {
  const result = await docker.run([
    'exec',
    container,
    'cat',
    `/proc/${pid}/cmdline`,
  ])
  if (result.status !== 0)
    return { available: false, argv: [], reason: 'command-unreadable' }
  const argv = result.stdout
    .split('\0')
    .filter((value) => value.length > 0)
    .map((value) => value.trim())
  return { available: true, argv, reason: null }
}

/** The observer is the wrapper; the command line must carry it in that order. */
export function commandCarriesObserver(argv) {
  const index = argv.indexOf(OBSERVER_MOUNT_PATH)
  if (index === -1) return false
  return argv[index + 1] === 'observe'
}

function countObserverRecords(text) {
  return text.split('\n').filter((line) => line.startsWith(OBSERVER_PREFIX))
    .length
}

/**
 * Bound a captured stream to the capture limit.
 *
 * The tail cut lands on an arbitrary byte and the captured stream can end in
 * the middle of a record. A partial last line is removed before the analyzer
 * sees the text, because the observer aborts on the first malformed observer
 * record and a lost analysis loses the whole observation.
 *
 * `truncated` says that the source was longer than the limit.
 */
export function boundCapture(text, limit, truncated = false) {
  const bytes = Buffer.from(text, 'utf8')
  let slice = bytes
  let wasTruncated = truncated
  if (bytes.length > limit) {
    slice = bytes.subarray(bytes.length - limit)
    wasTruncated = true
  }
  const complete = dropTrailingPartialLine(slice)
  if (complete.length !== slice.length) wasTruncated = true
  return { text: complete.toString('utf8'), truncated: wasTruncated }
}

function dropTrailingPartialLine(buffer) {
  if (buffer.length === 0) return buffer
  if (buffer[buffer.length - 1] === 0x0a) return buffer
  const last = buffer.lastIndexOf(0x0a)
  return last === -1 ? Buffer.alloc(0) : buffer.subarray(0, last + 1)
}

/**
 * Split a captured stream into the observer records the analyzer can read.
 *
 * The observer aborts on the first record that does not parse, which turns a
 * truncated capture into no analysis at all. A line that carries the observer
 * prefix but is not a complete record is not an observer event, so it is
 * dropped and counted. Every other line is kept unchanged, so the input
 * bounds of the observer still apply.
 */
export function splitObserverRecords(text) {
  const kept = []
  let dropped = 0
  for (const line of text.split('\n')) {
    if (!line.startsWith(OBSERVER_PREFIX)) {
      kept.push(line)
      continue
    }
    try {
      const parsed = JSON.parse(line.slice(OBSERVER_PREFIX.length))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        kept.push(line)
        continue
      }
    } catch {
      // Not a complete record.
    }
    dropped += 1
  }
  return { text: kept.join('\n'), dropped }
}

// The unchanged analyzer owns classification. Give it its own loss marker,
// while reserving one of its 4097 slots for that marker when needed.
export function prepareAnalyzerInput(text, truncated = false) {
  const split = splitObserverRecords(text)
  const lines = split.text
    .split('\n')
    .filter((line) => line.startsWith(OBSERVER_PREFIX))
  const starts = new Set()
  let reusedSession = false
  for (const line of lines) {
    const event = JSON.parse(line.slice(OBSERVER_PREFIX.length))
    if (
      event.event === 'start' &&
      Number.isInteger(event.session) &&
      event.session > 0
    ) {
      if (starts.has(event.session)) reusedSession = true
      starts.add(event.session)
    }
  }
  const overflow = lines.length > 4097
  const loss = truncated || split.dropped > 0 || overflow
  const marker = `${OBSERVER_PREFIX}{"event":"truncated"}`
  let selected = lines
  if (loss) {
    selected = lines
      .filter(
        (line) =>
          JSON.parse(line.slice(OBSERVER_PREFIX.length)).event !== 'truncated',
      )
      .slice(0, 4096)
    selected.push(marker)
  }
  return {
    text: selected.join('\n') + (selected.length ? '\n' : ''),
    accepted: lines.length,
    analyzedRecords: selected.length,
    omittedRecords:
      lines.length - (loss ? selected.length - 1 : selected.length),
    dropped: split.dropped,
    reusedSession,
    overflow,
    notified: loss,
  }
}

function containerJoin(directory, name) {
  return directory.endsWith('/')
    ? `${directory}${name}`
    : `${directory}/${name}`
}

async function resolveChildLogDirectory(docker, container, candidate) {
  if (candidate.childlogdir) return candidate.childlogdir
  const environment = await docker.run([
    'exec',
    container,
    'python3',
    '-c',
    'import tempfile; print(tempfile.gettempdir())',
  ])
  if (environment.status === 0) {
    const value = environment.stdout.trim()
    if (isAbsoluteContainerPath(value)) return value
  }
  // Do not guess when the container cannot resolve Python's temporary directory.
  return null
}

async function readChildLog(docker, container, candidate, limit) {
  const directory = await resolveChildLogDirectory(docker, container, candidate)
  if (!directory) return { available: false, text: '', truncated: false }
  const listing = await docker.run(
    ['exec', container, 'ls', '-1t', directory],
    { maxBuffer: 64 * 1024 },
  )
  if (listing.status !== 0)
    return { available: false, text: '', truncated: false }
  const names = listing.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, CHILD_LOG_FILE_LIMIT)
  if (names.length === 0)
    return { available: false, text: '', truncated: false }
  let fallback = null
  for (const name of names) {
    const path = containerJoin(directory, name)
    const result = await docker.run([
      'exec',
      container,
      'tail',
      '-c',
      String(limit + 1),
      path,
    ])
    if (result.status !== 0) continue
    const truncated = Buffer.byteLength(result.stdout, 'utf8') > limit
    const bounded = boundCapture(result.stdout, limit, truncated)
    if (countObserverRecords(bounded.text) > 0)
      return {
        available: true,
        text: bounded.text,
        truncated: bounded.truncated || names.length > 1,
      }
    if (!fallback)
      fallback = {
        available: true,
        text: bounded.text,
        truncated: bounded.truncated,
      }
  }
  return { available: false, text: '', truncated: fallback?.truncated ?? false }
}

async function readRoutingSource(docker, container, candidate, limit) {
  if (candidate.kind === 'container-output') {
    const result = await docker.run(
      ['logs', '--tail', String(CONTAINER_LOG_LINE_LIMIT), container],
      { maxBuffer: limit + 1 },
    )
    if (result.status !== 0)
      return { available: false, text: '', truncated: false }
    const truncated =
      Boolean(result.stderr) ||
      Buffer.byteLength(result.stdout, 'utf8') +
        Buffer.byteLength(result.stderr, 'utf8') >
        limit ||
      (result.stdout + result.stderr).split('\n').length -
        ((result.stdout + result.stderr).endsWith('\n') ? 1 : 0) >=
        CONTAINER_LOG_LINE_LIMIT
    const bounded = boundCapture(
      result.stdout + result.stderr,
      limit,
      truncated,
    )
    return { available: true, text: bounded.text, truncated: bounded.truncated }
  }
  if (candidate.kind === 'child-log')
    return readChildLog(docker, container, candidate, limit)
  const result = await docker.run([
    'exec',
    container,
    'tail',
    '-c',
    String(limit + 1),
    candidate.path,
  ])
  if (result.status !== 0)
    return { available: false, text: '', truncated: false }
  const truncated = Buffer.byteLength(result.stdout, 'utf8') > limit
  const bounded = boundCapture(result.stdout, limit, truncated)
  return { available: true, text: bounded.text, truncated: bounded.truncated }
}

// Keep Docker's container streams separate from the observer's routed records.
async function captureStartupOutput(docker, container, ledgerDir) {
  const metadata = {
    available: false,
    error: null,
    status: null,
    limitBytesPerStream: STARTUP_OUTPUT_LIMIT,
    stdoutBytes: 0,
    stderrBytes: 0,
    truncated: false,
  }
  try {
    const output = await docker.run(
      ['logs', '--tail', String(CONTAINER_LOG_LINE_LIMIT), container],
      {
        timeoutMs: STARTUP_OUTPUT_TIMEOUT_MS,
        maxBuffer: STARTUP_OUTPUT_LIMIT + 1,
      },
    )
    metadata.status = output.status
    if (output.timedOut || output.status !== 0) {
      metadata.error = output.timedOut ? 'timeout' : 'docker-logs-failed'
      return metadata
    }
    const stdout = Buffer.from(output.stdout, 'utf8')
    const stderr = Buffer.from(output.stderr, 'utf8')
    metadata.truncated =
      stdout.length > STARTUP_OUTPUT_LIMIT ||
      stderr.length > STARTUP_OUTPUT_LIMIT ||
      (output.stdout + output.stderr).split('\n').length - 1 >=
        CONTAINER_LOG_LINE_LIMIT
    const boundedStdout = stdout.subarray(0, STARTUP_OUTPUT_LIMIT)
    const boundedStderr = stderr.subarray(0, STARTUP_OUTPUT_LIMIT)
    writeLedgerFile(ledgerDir, 'startup-stdout.log', boundedStdout)
    writeLedgerFile(ledgerDir, 'startup-stderr.log', boundedStderr)
    metadata.stdoutBytes = boundedStdout.length
    metadata.stderrBytes = boundedStderr.length
    metadata.available = true
  } catch {
    metadata.error = 'capture-or-ledger-failed'
  }
  return metadata
}

/**
 * Capture the child stderr from the routes the extracted configuration allows.
 *
 * The route that actually carries the observer records is the proof. When no
 * route carries records, the capture stays empty and the report says so; it
 * never claims silence and never claims that the wrapper failed.
 */
async function captureChildStderr(docker, container, routing, limit) {
  if (routing.kind === 'unresolved' || routing.candidates.length === 0)
    return {
      available: false,
      text: '',
      source: null,
      truncated: false,
      observerRecords: 0,
      reason: 'routing-unresolved',
    }
  let fallback = null
  for (const candidate of routing.candidates) {
    const attempt = await readRoutingSource(docker, container, candidate, limit)
    if (!attempt.available) continue
    const records = countObserverRecords(attempt.text)
    if (records > 0)
      return {
        available: true,
        text: attempt.text,
        source: candidate.kind,
        path: candidate.path ?? null,
        truncated: attempt.truncated,
        observerRecords: records,
        reason: 'observer-records-captured',
      }
    if (!fallback)
      fallback = {
        available: true,
        text: attempt.text,
        source: candidate.kind,
        path: candidate.path ?? null,
        truncated: attempt.truncated,
        observerRecords: 0,
        reason: 'no-observer-records',
      }
  }
  if (fallback) return fallback
  return {
    available: false,
    text: '',
    source: null,
    truncated: false,
    observerRecords: 0,
    reason: 'capture-unavailable',
  }
}

async function analyzeCapture(docker, container, capture) {
  const split = prepareAnalyzerInput(capture.text, capture.truncated)
  if (split.reusedSession)
    throw diagnostic(
      'observer session ID reuse: merged capture refused',
      'analyze',
    )
  const result = await docker.run(
    ['exec', '-i', container, 'python3', OBSERVER_MOUNT_PATH, 'analyze'],
    { input: split.text },
  )
  if (result.stdinFailed) {
    const error = diagnostic('docker stdin write failed', 'analyze')
    error.stdinFailed = true
    throw error
  }
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
  return {
    analysis: validateObserverAnalysis(parsed),
    invalidRecords: split.dropped,
    acceptedRecords: split.accepted,
    overflow: split.overflow,
    truncationNotifiedToAnalyzer: split.notified,
  }
}

/**
 * Remove the resources this run created.
 *
 * Containers are removed before volumes, because a volume that is still
 * mounted by a container cannot be removed and would be leaked. Every removal
 * verifies the run label first, and a resource that was already removed is
 * never inspected again, so a retry is safe.
 */
async function removeOwned(docker, state) {
  const failures = []
  const pending = state.resources.filter(
    (resource) => !state.removedResources.has(resource.name),
  )
  const ordered = [
    ...pending.filter((resource) => resource.kind === 'container'),
    ...pending.filter((resource) => resource.kind !== 'container'),
  ]
  for (const resource of ordered) {
    try {
      const inspectArgs =
        resource.kind === 'container'
          ? ['inspect', '--format', '{{json .Config.Labels}}', resource.name]
          : ['volume', 'inspect', '--format', '{{json .Labels}}', resource.name]
      const inspected = await docker.run(inspectArgs)
      if (inspected.timedOut) throw new Error('docker inspect timed out')
      if (inspected.status !== 0) {
        const absent =
          resource.kind === 'container'
            ? /no such container/i
            : /no such volume/i
        if (inspected.status === 1 && absent.test(inspected.stderr)) {
          state.removedResources.add(resource.name)
          continue
        }
        throw new Error(`docker inspect failed with status ${inspected.status}`)
      }
      const parsed = JSON.parse(inspected.stdout)
      if (!parsed || parsed[state.labelKey] !== state.runId)
        throw new Error('label verification failed')
      const args =
        resource.kind === 'container'
          ? ['rm', '-f', resource.name]
          : ['volume', 'rm', resource.name]
      await dockerRun(docker, args, {}, 'cleanup')
      state.removedResources.add(resource.name)
    } catch (error) {
      failures.push({
        kind: resource.kind,
        name: resource.name,
        message: error.message,
      })
    }
  }
  return failures
}

function removeWorkDirectory(state, removeDirectory) {
  if (!state.workDir) return { errors: [], retained: null }
  if (
    state.resources.some(
      (resource) =>
        resource.kind === 'container' &&
        !state.removedResources.has(resource.name),
    )
  ) {
    return {
      errors: [],
      retained: { path: state.workDir, reason: 'owned-container-may-remain' },
    }
  }
  try {
    removeDirectory(state.workDir, { recursive: true, force: true })
    return { errors: [], retained: null }
  } catch {
    return {
      errors: [
        {
          kind: 'work-directory',
          name: state.workDir,
          message: 'work directory removal failed',
        },
      ],
      retained: { path: state.workDir, reason: 'removal-failed' },
    }
  }
}

/** Resolve a path to its canonical form, tolerating a missing leaf. */
export function canonicalPath(path) {
  const absolute = resolve(path)
  const missing = []
  let current = absolute
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) return absolute
    missing.unshift(basename(current))
    current = parent
  }
  let real
  try {
    real = realpathSync(current)
  } catch {
    real = current
  }
  return join(real, ...missing)
}

function gitOutput(args) {
  try {
    return execFileSync('git', ['-C', REPOSITORY_ROOT, ...args], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    throw diagnostic('repository exclusion discovery failed', 'preflight')
  }
}

/**
 * Every directory that belongs to the repository, including the linked
 * worktrees of the same repository and the shared git directory.
 */
export function repositoryExclusionRoots() {
  const roots = new Set()
  const add = (path) => {
    if (!path || !isAbsolute(path))
      throw diagnostic('invalid repository exclusion root', 'preflight')
    try {
      roots.add(realpathSync(path))
    } catch {
      throw diagnostic('unresolved repository exclusion root', 'preflight')
    }
  }
  add(REPOSITORY_ROOT)
  const common = gitOutput([
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]).trim()
  add(common)
  const worktrees = gitOutput(['worktree', 'list', '--porcelain', '-z'])
  if (!worktrees.endsWith('\0\0'))
    throw diagnostic('invalid worktree discovery', 'preflight')
  const paths = []
  for (const record of worktrees.slice(0, -2).split('\0\0')) {
    const fields = record.split('\0')
    const first = fields.shift()
    if (!first?.startsWith('worktree ') || !isAbsolute(first.slice(9)))
      throw diagnostic('invalid worktree record', 'preflight')
    const seen = new Set()
    for (const field of fields) {
      const key = field.split(' ', 1)[0]
      if (
        seen.has(key) ||
        !(
          /^HEAD [0-9a-f]{40,64}$/.test(field) ||
          /^branch refs\/[^\s]+$/.test(field) ||
          /^(bare|detached)$/.test(field) ||
          /^(locked|prunable)( .*)?$/.test(field)
        )
      )
        throw diagnostic('invalid worktree field', 'preflight')
      seen.add(key)
    }
    if (
      seen.has('bare')
        ? fields.length !== 1
        : !seen.has('HEAD') || seen.has('branch') === seen.has('detached')
    )
      throw diagnostic('incomplete worktree record', 'preflight')
    if (paths.includes(first.slice(9)))
      throw diagnostic('duplicate worktree record', 'preflight')
    paths.push(first.slice(9))
  }
  if (
    !paths.length ||
    !paths.some((path) => path === realpathSync(REPOSITORY_ROOT))
  )
    throw diagnostic('incomplete worktree discovery', 'preflight')
  for (const path of paths) add(path)
  return [...roots]
}

/**
 * Refuse a ledger that lives inside the repository or inside any linked
 * worktree of the same repository. Both sides are resolved, so a symlink
 * cannot smuggle the ledger inside the checkout.
 */
export function assertLedgerOutsideRepository(ledgerDir) {
  const canonical = canonicalPath(ledgerDir)
  for (const root of repositoryExclusionRoots()) {
    const relation = relative(root, canonical)
    if (
      relation === '' ||
      (!relation.startsWith('..') && !isAbsolute(relation))
    )
      throw diagnostic(
        'ledger directory must stay outside the repository and every linked worktree',
        'preflight',
      )
  }
  return canonical
}

/**
 * Run the diagnostic. The function never throws raw Docker output and always
 * cleans up the resources this run created, independently of one another.
 */
export async function runDiagnostic(options) {
  const docker = options.docker
  const clock = options.clock ?? { now: () => Date.now() }
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const settings = {
    composeFile:
      options.composeFile ??
      join(REPOSITORY_ROOT, 'infra/sim/docker-compose.yml'),
    observerPath:
      options.observerPath ??
      join(REPOSITORY_ROOT, 'infra/sim/experiments/serial_diagnostic.py'),
    image: options.image ?? PINNED_IMAGE_REFERENCE,
    platform: options.platform ?? PINNED_PLATFORM,
    observationMs: options.observationMs ?? READINESS_BUDGET_MS,
  }
  assertRunSettings(settings, 'settings')
  const runId = options.runId
  const state = {
    runName: options.runName,
    runId,
    labelKey: LABEL_KEY,
    labelArguments: [
      '--label',
      `${LABEL_KEY}=${runId}`,
      '--label',
      `${LABEL_RUN_KEY}=${options.runName}`,
    ],
    resources: [],
    removedResources: new Set(),
    workDir: null,
    phase: 'preflight',
    stages: {},
  }
  const runStartedAt = clock.now()
  let stageStart = runStartedAt
  let currentStage = 'preflight'
  const enterStage = (name) => {
    const now = clock.now()
    state.stages[currentStage] = now - stageStart
    currentStage = name
    state.phase = name
    stageStart = now
  }

  let ledgerDir = options.ledgerDir
  if (!ledgerDir) {
    const base = canonicalPath(tmpdir())
    assertLedgerOutsideRepository(base)
    ledgerDir = mkdtempSync(join(base, 'open3dfm-identify-diagnostic-'))
  }
  const requestedLedger = ledgerDir
  if (
    existsSync(requestedLedger) &&
    lstatSync(requestedLedger).isSymbolicLink()
  )
    throw diagnostic('ledger directory must not be a symlink', 'preflight')
  ledgerDir = assertLedgerOutsideRepository(requestedLedger)
  mkdirSync(ledgerDir, { recursive: true, mode: 0o700 })
  const ledgerStat = lstatSync(ledgerDir)
  if (
    !ledgerStat.isDirectory() ||
    (ledgerStat.mode & 0o077) !== 0 ||
    (typeof process.getuid === 'function' &&
      ledgerStat.uid !== process.getuid())
  )
    throw diagnostic(
      'ledger directory must be private and owned by the current user',
      'preflight',
    )
  state.workDir = join(ledgerDir, 'work')
  mkdirSync(state.workDir, { mode: 0o700 })

  let result = null
  let pendingFailure = null
  let caughtError = null
  try {
    // Phase: preflight ---------------------------------------------------
    const composeDigest = verifyComposePin(settings.composeFile)
    const observer = verifyObserverSource(settings.observerPath)
    const pinnedImage = settings.image

    // Phase: baseline ----------------------------------------------------
    enterStage('baseline')
    const baseline = []
    const baselineFailures = []
    for (const [name, args] of [
      ['containers', ['ps', '-a', '--no-trunc']],
      ['images', ['images', '--digests', '--no-trunc']],
      ['volumes', ['volume', 'ls']],
      ['networks', ['network', 'ls']],
      ['disk', ['system', 'df']],
    ]) {
      const result_ = await docker.run(args)
      if (result_.status !== 0)
        baselineFailures.push({ command: name, status: result_.status })
      baseline.push(`# ${name}\n${result_.stdout}${result_.stderr}`)
    }
    writeLedgerFile(
      ledgerDir,
      'baseline.txt',
      `run=${state.runName}\nimage=${pinnedImage}\n${baseline.join('\n')}`,
    )

    // Phase: discover ----------------------------------------------------
    enterStage('discover')
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
    enterStage('transform')
    const transformed = transformSupervisorConfig(discovered.configText, {
      observerPath: OBSERVER_MOUNT_PATH,
    })
    writeLedgerFile(ledgerDir, 'supervisord.transformed.conf', transformed.text)
    const transformedPath = join(state.workDir, 'supervisord.transformed.conf')
    writeFileSync(transformedPath, transformed.text, { mode: 0o600 })

    // Phase: source gate -------------------------------------------------
    enterStage('sources')
    const sourcePins = observer.pins
    const verifiedSources = await verifyKlipperSources(
      docker,
      state,
      transformed.delta.klipperRoot,
      sourcePins,
    )

    // Phase: observe -----------------------------------------------------
    enterStage('observe')
    const volumeName = `${state.runName}-data`
    state.resources.push({ kind: 'volume', name: volumeName })
    await dockerRun(
      docker,
      ['volume', 'create', ...state.labelArguments, volumeName],
      {},
      'observe',
    )
    const containerName = state.runName
    const containerArguments = buildContainerArguments({
      name: containerName,
      platform: settings.platform,
      image: pinnedImage,
      cpus: '2.0',
      memory: '1g',
      pidsLimit: '256',
      labels: [
        [state.labelKey, runId],
        [LABEL_RUN_KEY, state.runName],
      ],
      volume: volumeName,
      observerHostPath: settings.observerPath,
      configHostPath: transformedPath,
      configContainerPath: discovered.configPath,
    })
    assertContainerIsolation(containerArguments)
    state.resources.push({ kind: 'container', name: containerName })
    await dockerRun(docker, containerArguments, {}, 'observe')
    await dockerRun(docker, ['start', containerName], {}, 'observe')

    const startedAt = clock.now()
    const deadline = startedAt + settings.observationMs
    while (clock.now() < deadline) {
      const remaining = Math.max(1, deadline - clock.now())
      const status = await dockerRun(
        docker,
        ['inspect', '--format', '{{.State.Status}}', containerName],
        { timeoutMs: remaining },
        'observe',
      )
      if (status.stdout.trim() === 'exited') break
      await sleep(Math.min(1000, Math.max(0, deadline - clock.now())))
    }
    const observedFor = clock.now() - startedAt
    const startupOutput = await captureStartupOutput(
      docker,
      containerName,
      ledgerDir,
    )

    // Phase: verification ------------------------------------------------
    enterStage('verify')
    const supervisor = await readSupervisorStatus(docker, containerName)
    const processes = supervisor.available ? supervisor.states : 'unavailable'
    let wrapperApplied = 'unavailable'
    let wrapperReason = 'supervisor-unavailable'
    if (supervisor.available) {
      const klipperPid = supervisor.pids.klipper
      if (klipperPid === undefined) {
        wrapperReason = 'program-not-running'
      } else {
        const command = await readProcessCommand(
          docker,
          containerName,
          klipperPid,
        )
        if (!command.available) {
          wrapperReason = 'command-unreadable'
        } else {
          wrapperApplied = commandCarriesObserver(command.argv)
          wrapperReason = wrapperApplied
            ? 'observer-in-command'
            : 'observer-absent-from-command'
        }
      }
    }

    // Phase: capture -----------------------------------------------------
    enterStage('capture')
    const parsedConfig = parseSupervisorConfig(discovered.configText)
    const program = findKlipperProgram(parsedConfig).section
    const routing = resolveStderrRouting(
      program,
      findSupervisorServerSection(parsedConfig),
    )
    writeLedgerFile(
      ledgerDir,
      'paths.txt',
      `configuration=${discovered.configPath}\nrouting=${routing.kind}\n`,
    )
    let capture = {
      available: false,
      text: '',
      source: null,
      truncated: false,
      observerRecords: 0,
      reason: 'wrapper-not-applied',
    }
    if (wrapperApplied === false) {
      // The transformation provably did not reach the running process. A
      // capture from it would prove nothing, so the capture is skipped and
      // the run reports the verified absence instead of a false capture.
      pendingFailure = new DiagnosticError(
        'the observer wrapper is not in the running klippy process command line',
        { phase: 'verify' },
      )
    } else {
      capture = await captureChildStderr(
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
    }

    // Phase: analyze -----------------------------------------------------
    enterStage('analyze')
    let analysis = null
    let analysisError = null
    const prepared = prepareAnalyzerInput(capture.text, capture.truncated)
    let invalidRecords = prepared.dropped
    if (capture.available && capture.observerRecords > 0) {
      try {
        const analyzed = await analyzeCapture(docker, containerName, capture)
        analysis = analyzed.analysis
        invalidRecords = analyzed.invalidRecords
      } catch (error) {
        analysisError = error.message
        if (error.stdinFailed) throw error
      }
    }

    // Phase: report ------------------------------------------------------
    enterStage('report')
    const inspected = await dockerJson(
      docker,
      ['inspect', '--format', '{{json .State}}', containerName],
      {},
      'report',
    )
    const containerState =
      typeof inspected === 'string' ? JSON.parse(inspected) : inspected
    result = {
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
      baseline: {
        recorded: true,
        failures: baselineFailures,
      },
      observation: {
        budgetMs: READINESS_BUDGET_MS,
        windowMs: settings.observationMs,
        observedMs: observedFor,
        exceededBudget: observedFor > READINESS_BUDGET_MS,
      },
      routing: {
        kind: capture.source ?? 'unresolved',
        candidates: routing.candidates.map((candidate) => candidate.kind),
        pathDigest: capture.path ? sha256(capture.path) : null,
        evidence: capture.observerRecords > 0 ? 'observer-records' : 'none',
        ambiguous: routing.ambiguous,
      },
      capture: {
        available: capture.available,
        reason: capture.reason,
        bytes: Buffer.byteLength(capture.text, 'utf8'),
        limitBytes: CAPTURE_BYTE_LIMIT,
        observerRecords: prepared.accepted,
        prefixRecords: prepared.accepted + prepared.dropped,
        analyzedRecords: prepared.analyzedRecords,
        omittedRecords: prepared.omittedRecords,
        invalidRecords,
        sessionIdReused: prepared.reusedSession,
        eventOverflow: prepared.overflow,
        overflowReason: prepared.overflow
          ? 'observer-event-limit-exceeded'
          : null,
        truncationNotifiedToAnalyzer: Boolean(analysis && prepared.notified),
        truncated: capture.truncated,
        source: capture.source,
      },
      startupOutput,
      supervisorObservation: supervisor.available ? 'observed' : 'unavailable',
      wrapperApplied,
      wrapperReason,
      processes,
      observerAnalysis: analysis,
      observerAnalysisError: analysisError,
      readiness: 'not-evaluated',
      conclusion:
        'diagnostic-only observation; no readiness acceptance and no retry',
      ledger: ledgerDir,
    }
  } catch (error) {
    caughtError = error
  }

  enterStage('cleanup')
  const cleanupErrors = await removeOwned(docker, state)
  // A removal that failed is retried once. The retry only touches the
  // resources that are still there, so it is the final state of the cleanup.
  const retried =
    cleanupErrors.length > 0 ? await removeOwned(docker, state) : null
  const finalCleanupErrors = (retried ?? []).map((retry) => {
    const first = cleanupErrors.find(
      (entry) => entry.kind === retry.kind && entry.name === retry.name,
    )
    return {
      ...retry,
      message: first
        ? `${first.message}; retry: ${retry.message}`
        : retry.message,
    }
  })
  const workCleanup = removeWorkDirectory(
    state,
    options.removeDirectory ?? rmSync,
  )
  finalCleanupErrors.push(...workCleanup.errors)
  state.stages.cleanup = clock.now() - stageStart
  if (result) {
    result.cleanup = {
      errors: finalCleanupErrors,
      firstAttemptErrors: cleanupErrors,
      retainedWorkDirectory: workCleanup.retained,
      completed: finalCleanupErrors.length === 0,
    }
    result.stages = state.stages
    result.totalElapsedMs = clock.now() - runStartedAt
  }
  const persistenceErrors = []
  for (const [name, content] of [
    ['result.json', result],
    ['retained-work.json', workCleanup.retained],
  ]) {
    if (!content) continue
    try {
      writeLedgerFile(ledgerDir, name, JSON.stringify(content, null, 2))
    } catch {
      persistenceErrors.push({ name, message: 'exclusive ledger write failed' })
    }
  }
  let failure = caughtError ?? pendingFailure
  if (!failure && finalCleanupErrors.length > 0)
    failure = new DiagnosticError('cleanup did not complete', {
      phase: 'cleanup',
      cleanupErrors: finalCleanupErrors,
    })
  if (!failure && persistenceErrors.length > 0)
    failure = diagnostic('ledger persistence did not complete', 'report')
  if (failure) {
    if (failure instanceof DiagnosticError) {
      failure.cleanupErrors = finalCleanupErrors
      failure.persistenceErrors = persistenceErrors
      failure.firstCleanupErrors = cleanupErrors
      if (result) failure.result = result
      throw failure
    }
    const wrapped = new DiagnosticError(failure.message, {
      phase: state.phase,
      cause: failure,
      cleanupErrors: finalCleanupErrors,
    })
    wrapped.persistenceErrors = persistenceErrors
    wrapped.firstCleanupErrors = cleanupErrors
    throw wrapped
  }
  return result
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
    if (error.result)
      process.stdout.write(`${JSON.stringify(error.result, null, 2)}\n`)
    process.stderr.write(
      `${JSON.stringify({
        error: error.message,
        phase: error.phase ?? 'unknown',
        cleanupErrors: error.cleanupErrors ?? [],
        firstCleanupErrors: error.firstCleanupErrors ?? [],
        persistenceErrors: error.persistenceErrors ?? [],
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
