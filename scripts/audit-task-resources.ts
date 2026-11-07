// Read-only development resource audit for exactly one task label.
// Reports disk capacity, Git worktree state and Docker resources owned by the label.
// It never creates, starts, stops, removes, prunes or mutates anything.
import { execFile } from 'node:child_process'
import { stat, statfs } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export const TASK_LABEL_KEY = 'o3dfm.task'
export const TOOL_NAME = 'audit-task-resources'
export const TOOL_VERSION = 1

const FIELD_SEPARATOR = '\x1f'
const DOCKER_TIMEOUT_MS = 15_000
const GIT_TIMEOUT_MS = 15_000
const DOCKER_MAX_BUFFER = 4 * 1024 * 1024
const GIT_MAX_BUFFER = 1024 * 1024
const MAX_LISTED_ENTRIES = 200
const MAX_SAMPLE_ENTRIES = 10
const MAX_STATUS_SAMPLE = 10
const MAX_LISTED_LINES = 5_000
const MAX_TASK_LABEL_LENGTH = 128

export const EXIT_COMPLETE = 0
export const EXIT_USAGE = 1
export const EXIT_PARTIAL = 2
export const EXIT_LEFTOVERS = 3

export type ResourceKind = 'container' | 'volume' | 'network'

/**
 * `task-owned` requires the label value to equal the requested value exactly.
 * A resource whose name merely contains the label text is never task-owned.
 */
export type Ownership = 'task-owned' | 'other-task' | 'unlabeled'

export interface ResourceEntry {
  kind: ResourceKind
  id: string
  name: string
  taskLabel: string
  state: string | null
  image: string | null
  platform: string | null
  driver: string | null
  createdAt: string | null
}

export interface StatusCounts {
  staged: number
  modified: number
  untracked: number
  renamed: number
  conflicted: number
}

export interface WorktreeState {
  path: string
  branch: string | null
  head: string | null
  detached: boolean
  dirty: boolean
  counts: StatusCounts
  sample: string[]
}

export interface FilesystemUsage {
  path: string
  device: string
  totalBytes: number
  freeBytes: number
  usedBytes: number
  usedPercent: number
}

export interface CommandResult {
  code: number | null
  stdout: string
  stderr: string
  failed: boolean
  error: string | null
}

export interface CommandOptions {
  timeoutMs: number
  maxBuffer: number
}

export type CommandRunner = (
  file: string,
  args: string[],
  options: CommandOptions,
) => Promise<CommandResult>

export interface AuditEnvironment {
  run: CommandRunner
  capacity: (path: string) => Promise<FilesystemUsage | null>
  now: () => Date
}

export interface AuditOptions {
  taskLabel: string
  repository: string
  pretty: boolean
}

export interface AuditSectionStatus {
  status: 'ok' | 'partial' | 'unavailable'
  reason: string | null
}

export interface OwnershipBucket {
  count: number
  truncated: boolean
  sample: ResourceSummary[]
}

/** Full detail for resources owned by the audited task. */
export interface OwnedBucket {
  count: number
  truncated: boolean
  items: ResourceEntry[]
}

/**
 * Minimal shape used for resources that are not owned by the audited task.
 * Other projects' image, state and creation details stay out of the report.
 */
export interface ResourceSummary {
  kind: ResourceKind
  id: string
  name: string
  taskLabel: string
}

export interface AuditReport {
  tool: string
  version: number
  generatedAt: string
  taskLabel: string
  labelKey: string
  repository: string
  status: 'complete' | 'partial'
  exitCode: number
  filesystem: AuditSectionStatus & { capacity: FilesystemUsage[] }
  git: AuditSectionStatus & { worktrees: WorktreeState[] }
  docker: AuditSectionStatus & {
    serverVersion: string | null
    owned: Record<ResourceKind, OwnedBucket>
    otherTask: Record<ResourceKind, OwnershipBucket>
    unlabeled: Record<ResourceKind, OwnershipBucket>
  }
  notes: string[]
}

export interface ParsedArgs {
  ok: true
  value: AuditOptions & { help: boolean }
}

export interface ParseFailure {
  ok: false
  error: string
}

export const USAGE = `Usage: node scripts/audit-task-resources.ts --task-label <value> [--repo <path>] [--pretty]

Reports disk capacity, Git worktree state and Docker containers, volumes and
networks whose "${TASK_LABEL_KEY}" label equals <value> exactly.

Options:
  --task-label <value>  Required. Exact owning task label value.
  --repo <path>         Repository to audit. Defaults to the repository that
                        contains this script.
  --pretty              Indent the JSON report.
  -h, --help            Show this help.

Exit codes:
  ${EXIT_COMPLETE}  Complete report, no task-owned resource present.
  ${EXIT_USAGE}  Usage error.
  ${EXIT_PARTIAL}  Partial report; at least one section was unavailable.
  ${EXIT_LEFTOVERS}  Complete report; task-owned resources are still present.

This tool is read-only. It never creates, stops, removes or prunes anything.`

/** Validates the requested label value. The value is compared literally later. */
export function validateTaskLabel(
  raw: string,
): { ok: true; value: string } | ParseFailure {
  if (raw.length === 0)
    return { ok: false, error: 'Task label value must not be empty' }
  if (raw !== raw.trim())
    return {
      ok: false,
      error: 'Task label value must not have leading or trailing whitespace',
    }
  if (/[\u0000-\u001f\u007f]/.test(raw))
    return {
      ok: false,
      error: 'Task label value must not contain control characters',
    }
  if (raw.length > MAX_TASK_LABEL_LENGTH)
    return {
      ok: false,
      error: `Task label value must be at most ${MAX_TASK_LABEL_LENGTH} characters`,
    }
  return { ok: true, value: raw }
}

export function parseAuditArgs(argv: string[]): ParsedArgs | ParseFailure {
  let taskLabel: string | null = null
  let repository: string | null = null
  let pretty = false
  let help = false

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === undefined) continue
    if (argument === '-h' || argument === '--help') {
      help = true
      continue
    }
    if (argument === '--pretty') {
      pretty = true
      continue
    }
    if (argument === '--task-label' || argument === '--repo') {
      const value = argv[index + 1]
      if (value === undefined)
        return { ok: false, error: `Missing value for ${argument}` }
      if (argument === '--task-label') taskLabel = value
      else repository = value
      index += 1
      continue
    }
    if (argument.startsWith('--task-label=')) {
      taskLabel = argument.slice('--task-label='.length)
      continue
    }
    if (argument.startsWith('--repo=')) {
      repository = argument.slice('--repo='.length)
      continue
    }
    return { ok: false, error: `Unknown argument: ${argument}` }
  }

  if (help)
    return {
      ok: true,
      value: { taskLabel: '', repository: '', pretty, help: true },
    }
  if (taskLabel === null)
    return {
      ok: false,
      error: `Missing required --task-label <value> (the exact "${TASK_LABEL_KEY}" label value)`,
    }
  const validated = validateTaskLabel(taskLabel)
  if (!validated.ok) return validated
  return {
    ok: true,
    value: {
      taskLabel: validated.value,
      repository: normalizePath(repository ?? defaultRepository()),
      pretty,
      help: false,
    },
  }
}

export function defaultRepository(): string {
  return normalizePath(fileURLToPath(new URL('../', import.meta.url)))
}

/** Removes a trailing separator so repository and worktree paths compare equal. */
export function normalizePath(path: string): string {
  if (path.length > 1 && path.endsWith('/'))
    return path.replace(/\/+$/, '') || '/'
  return path
}

/** Exact label comparison. Name similarity never grants ownership. */
export function classifyOwnership(
  taskLabel: string,
  requested: string,
): Ownership {
  if (taskLabel.length === 0) return 'unlabeled'
  return taskLabel === requested ? 'task-owned' : 'other-task'
}

export function parseResourceLine(
  kind: ResourceKind,
  line: string,
): ResourceEntry | null {
  if (line.length === 0) return null
  const parts = line.split(FIELD_SEPARATOR)
  const labelPart = parts[parts.length - 1]
  if (labelPart === undefined) return null
  let taskLabel: string
  try {
    const parsed: unknown = JSON.parse(labelPart)
    if (typeof parsed !== 'string') return null
    taskLabel = parsed
  } catch {
    return null
  }
  const head = parts.slice(0, -1)

  if (kind === 'container') {
    const [id, name, state, image, platform, createdAt] = head
    if (id === undefined || name === undefined) return null
    return {
      kind,
      id,
      name,
      taskLabel,
      state: state ?? null,
      image: image ?? null,
      platform: platform ?? null,
      createdAt: createdAt ?? null,
      driver: null,
    }
  }
  if (kind === 'volume') {
    const [name, driver] = head
    if (name === undefined) return null
    return {
      kind,
      id: name,
      name,
      taskLabel,
      state: null,
      image: null,
      platform: null,
      createdAt: null,
      driver: driver ?? null,
    }
  }
  const [id, name, driver, createdAt] = head
  if (id === undefined || name === undefined) return null
  return {
    kind,
    id,
    name,
    taskLabel,
    state: null,
    image: null,
    platform: null,
    createdAt: createdAt ?? null,
    driver: driver ?? null,
  }
}

export function partitionByOwnership(
  entries: ResourceEntry[],
  requested: string,
): {
  owned: ResourceEntry[]
  otherTask: ResourceEntry[]
  unlabeled: ResourceEntry[]
} {
  const owned: ResourceEntry[] = []
  const otherTask: ResourceEntry[] = []
  const unlabeled: ResourceEntry[] = []
  for (const entry of entries) {
    const ownership = classifyOwnership(entry.taskLabel, requested)
    if (ownership === 'task-owned') owned.push(entry)
    else if (ownership === 'other-task') otherTask.push(entry)
    else unlabeled.push(entry)
  }
  return { owned, otherTask, unlabeled }
}

export function summarizeStatus(entries: string[]): StatusCounts {
  const counts: StatusCounts = {
    staged: 0,
    modified: 0,
    untracked: 0,
    renamed: 0,
    conflicted: 0,
  }
  for (const entry of entries) {
    if (entry.length < 3) continue
    const code = entry.slice(0, 2)
    if (code === '??') {
      counts.untracked += 1
      continue
    }
    if (code === '!!') continue
    const x = code[0] ?? ' '
    const y = code[1] ?? ' '
    if (x !== ' ' && x !== '?') counts.staged += 1
    if (y !== ' ' && y !== '?') counts.modified += 1
    if (x === 'R' || y === 'R') counts.renamed += 1
    if (
      x === 'U' ||
      y === 'U' ||
      (x === 'A' && y === 'A') ||
      (x === 'D' && y === 'D')
    )
      counts.conflicted += 1
  }
  return counts
}

export function parseWorktreeList(output: string): {
  path: string
  branch: string | null
  head: string | null
  detached: boolean
}[] {
  const worktrees: {
    path: string
    branch: string | null
    head: string | null
    detached: boolean
  }[] = []
  let current: {
    path: string
    branch: string | null
    head: string | null
    detached: boolean
  } | null = null

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trimEnd()
    if (line.length === 0) {
      if (current) worktrees.push(current)
      current = null
      continue
    }
    if (line.startsWith('worktree ')) {
      if (current) worktrees.push(current)
      current = {
        path: line.slice('worktree '.length),
        branch: null,
        head: null,
        detached: false,
      }
      continue
    }
    if (!current) continue
    if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length)
    else if (line.startsWith('branch '))
      current.branch = line
        .slice('branch '.length)
        .replace(/^refs\/heads\//, '')
    else if (line === 'detached') current.detached = true
  }
  if (current) worktrees.push(current)
  return worktrees
}

export function summarizeStatusSample(entries: string[]): string[] {
  const sample: string[] = []
  for (const entry of entries) {
    if (entry.length < 4) continue
    const path = entry.slice(3).trim()
    if (path.length === 0) continue
    sample.push(path.replace(/^"(.*)"$/, '$1'))
    if (sample.length >= MAX_STATUS_SAMPLE) break
  }
  return sample
}

const DOCKER_FORMATS: Record<ResourceKind, string> = {
  container:
    '{{printf "%s\\x1f%s\\x1f%s\\x1f%s\\x1f%s\\x1f%s\\x1f%s" .ID .Names .State .Image .Platform .CreatedAt (json (.Label "o3dfm.task"))}}',
  volume:
    '{{printf "%s\\x1f%s\\x1f%s" .Name .Driver (json (.Label "o3dfm.task"))}}',
  network:
    '{{printf "%s\\x1f%s\\x1f%s\\x1f%s\\x1f%s" .ID .Name .Driver .CreatedAt (json (.Label "o3dfm.task"))}}',
}

const DOCKER_LIST_COMMANDS: Record<ResourceKind, string[]> = {
  container: ['ps', '-a'],
  volume: ['volume', 'ls'],
  network: ['network', 'ls'],
}

export const runCommand: CommandRunner = (file, args, options) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer,
        encoding: 'utf8',
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr, failed: false, error: null })
          return
        }
        const code =
          typeof (error as { code?: unknown }).code === 'number'
            ? (error as { code: number }).code
            : null
        resolve({
          code,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          failed: true,
          error: error.message,
        })
      },
    )
  })

export async function readCapacity(
  path: string,
): Promise<FilesystemUsage | null> {
  try {
    const info = await stat(path)
    const stats = await statfs(path)
    const bsize = Number(stats.bsize)
    const totalBytes = Number(stats.blocks) * bsize
    const freeBytes = Number(stats.bavail) * bsize
    const usedBytes = totalBytes - Number(stats.bfree) * bsize
    return {
      path,
      device: String(info.dev),
      totalBytes,
      freeBytes,
      usedBytes,
      usedPercent:
        totalBytes > 0
          ? Math.round((usedBytes / totalBytes) * 10_000) / 100
          : 0,
    }
  } catch {
    return null
  }
}

function emptyBucket(): OwnershipBucket {
  return { count: 0, truncated: false, sample: [] }
}

function emptyOwnedBucket(): OwnedBucket {
  return { count: 0, truncated: false, items: [] }
}

/** Non-owned resources are summarised by name only. */
function bucketOf(entries: ResourceEntry[]): OwnershipBucket {
  return {
    count: entries.length,
    truncated: entries.length > MAX_LISTED_ENTRIES,
    sample: entries.slice(0, MAX_SAMPLE_ENTRIES).map((entry) => ({
      kind: entry.kind,
      id: entry.id,
      name: entry.name,
      taskLabel: entry.taskLabel,
    })),
  }
}

/** Task-owned resources keep their full detail so cleanup can be planned. */
function ownedBucketOf(entries: ResourceEntry[]): OwnedBucket {
  return {
    count: entries.length,
    truncated: entries.length > MAX_LISTED_ENTRIES,
    items: entries.slice(0, MAX_LISTED_ENTRIES),
  }
}

async function collectDocker(
  options: AuditOptions,
  environment: AuditEnvironment,
): Promise<AuditReport['docker']> {
  const version = await environment.run(
    'docker',
    ['version', '--format', '{{.Server.Version}}'],
    { timeoutMs: DOCKER_TIMEOUT_MS, maxBuffer: 64 * 1024 },
  )
  const serverVersion = version.stdout.trim()
  if (version.failed || serverVersion.length === 0)
    return {
      status: 'unavailable',
      reason: `Docker daemon unavailable: ${(version.stderr || version.error || 'unknown error').trim().split('\n')[0] ?? 'unknown error'}`,
      serverVersion: null,
      owned: {
        container: emptyOwnedBucket(),
        volume: emptyOwnedBucket(),
        network: emptyOwnedBucket(),
      },
      otherTask: {
        container: emptyBucket(),
        volume: emptyBucket(),
        network: emptyBucket(),
      },
      unlabeled: {
        container: emptyBucket(),
        volume: emptyBucket(),
        network: emptyBucket(),
      },
    }

  const owned: Record<ResourceKind, ResourceEntry[]> = {
    container: [],
    volume: [],
    network: [],
  }
  const otherTask: Record<ResourceKind, ResourceEntry[]> = {
    container: [],
    volume: [],
    network: [],
  }
  const unlabeled: Record<ResourceKind, ResourceEntry[]> = {
    container: [],
    volume: [],
    network: [],
  }

  const incomplete: string[] = []
  for (const kind of ['container', 'volume', 'network'] as ResourceKind[]) {
    const listed = await environment.run(
      'docker',
      [...DOCKER_LIST_COMMANDS[kind], '--format', DOCKER_FORMATS[kind]],
      { timeoutMs: DOCKER_TIMEOUT_MS, maxBuffer: DOCKER_MAX_BUFFER },
    )
    if (listed.failed) {
      return {
        status: 'unavailable',
        reason: `Docker ${kind} listing failed: ${(listed.stderr || listed.error || 'unknown error').trim().split('\n')[0] ?? 'unknown error'}`,
        serverVersion,
        owned: {
          container: emptyOwnedBucket(),
          volume: emptyOwnedBucket(),
          network: emptyOwnedBucket(),
        },
        otherTask: {
          container: emptyBucket(),
          volume: emptyBucket(),
          network: emptyBucket(),
        },
        unlabeled: {
          container: emptyBucket(),
          volume: emptyBucket(),
          network: emptyBucket(),
        },
      }
    }
    const entries: ResourceEntry[] = []
    let listedLines = 0
    let invalidLines = 0
    for (const line of listed.stdout.split('\n')) {
      if (line.length === 0) continue
      if (++listedLines > MAX_LISTED_LINES) {
        incomplete.push(`${kind} listing exceeded ${MAX_LISTED_LINES} rows`)
        break
      }
      const entry = parseResourceLine(kind, line)
      if (entry) entries.push(entry)
      else invalidLines++
    }
    if (invalidLines > 0)
      incomplete.push(`${kind} listing contained ${invalidLines} invalid rows`)
    const partition = partitionByOwnership(entries, options.taskLabel)
    owned[kind] = partition.owned
    otherTask[kind] = partition.otherTask
    unlabeled[kind] = partition.unlabeled
  }

  return {
    status: incomplete.length > 0 ? 'partial' : 'ok',
    reason: incomplete.length > 0 ? incomplete.join('; ') : null,
    serverVersion,
    owned: {
      container: ownedBucketOf(owned.container),
      volume: ownedBucketOf(owned.volume),
      network: ownedBucketOf(owned.network),
    },
    otherTask: {
      container: bucketOf(otherTask.container),
      volume: bucketOf(otherTask.volume),
      network: bucketOf(otherTask.network),
    },
    unlabeled: {
      container: bucketOf(unlabeled.container),
      volume: bucketOf(unlabeled.volume),
      network: bucketOf(unlabeled.network),
    },
  }
}

async function collectGit(
  options: AuditOptions,
  environment: AuditEnvironment,
): Promise<AuditReport['git']> {
  const listed = await environment.run(
    'git',
    [
      '--no-optional-locks',
      '-C',
      options.repository,
      'worktree',
      'list',
      '--porcelain',
    ],
    { timeoutMs: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER },
  )
  if (listed.failed)
    return {
      status: 'unavailable',
      reason: `Git worktree listing failed: ${(listed.stderr || listed.error || 'unknown error').trim().split('\n')[0] ?? 'unknown error'}`,
      worktrees: [],
    }

  const worktrees: WorktreeState[] = []
  for (const described of parseWorktreeList(listed.stdout)) {
    const status = await environment.run(
      'git',
      [
        '--no-optional-locks',
        '-C',
        described.path,
        'status',
        '--porcelain=v1',
        '--untracked-files=normal',
      ],
      { timeoutMs: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER },
    )
    if (status.failed)
      return {
        status: 'unavailable',
        reason: `Git status failed for worktree ${described.path}: ${(status.stderr || status.error || 'unknown error').trim().split('\n')[0] ?? 'unknown error'}`,
        worktrees,
      }
    const entries = status.stdout.split('\n').filter((line) => line.length > 0)
    const counts = summarizeStatus(entries)
    worktrees.push({
      path: described.path,
      branch: described.branch,
      head: described.head,
      detached: described.detached,
      dirty: entries.length > 0,
      counts,
      sample: summarizeStatusSample(entries),
    })
  }
  return { status: 'ok', reason: null, worktrees }
}

export async function buildReport(
  options: AuditOptions,
  environment: AuditEnvironment,
): Promise<AuditReport> {
  const [git, docker] = await Promise.all([
    collectGit(options, environment),
    collectDocker(options, environment),
  ])

  const capacity: FilesystemUsage[] = []
  const failedCapacityPaths: string[] = []
  const capacityPaths = new Set<string>()
  for (const worktree of git.worktrees) capacityPaths.add(worktree.path)
  capacityPaths.add(options.repository)
  for (const path of capacityPaths) {
    const usage = await environment.capacity(path)
    if (!usage) {
      failedCapacityPaths.push(path)
      continue
    }
    const duplicate = capacity.some((entry) => entry.path === usage.path)
    if (!duplicate) capacity.push(usage)
  }
  const filesystem: AuditReport['filesystem'] = {
    status:
      capacity.length === 0
        ? 'unavailable'
        : failedCapacityPaths.length > 0
          ? 'partial'
          : 'ok',
    reason:
      failedCapacityPaths.length > 0
        ? `Filesystem capacity could not be read for: ${JSON.stringify(failedCapacityPaths)}`
        : null,
    capacity,
  }

  const ownedCount =
    docker.owned.container.count +
    docker.owned.volume.count +
    docker.owned.network.count
  const status: AuditReport['status'] =
    git.status === 'ok' && docker.status === 'ok' && filesystem.status === 'ok'
      ? 'complete'
      : 'partial'

  const exitCode =
    status === 'partial'
      ? EXIT_PARTIAL
      : ownedCount > 0
        ? EXIT_LEFTOVERS
        : EXIT_COMPLETE

  const notes: string[] = [
    'Read-only audit. No resource was created, stopped, removed or pruned.',
    'Task ownership requires an exact "' +
      TASK_LABEL_KEY +
      '" label value match. Resource names are never used to infer ownership.',
    'Resources under other-task and unlabeled are not owned by this task and are not audited further.',
  ]
  if (status === 'partial')
    notes.push(
      'Partial report: at least one section was unavailable or incomplete.',
    )

  return {
    tool: TOOL_NAME,
    version: TOOL_VERSION,
    generatedAt: environment.now().toISOString(),
    taskLabel: options.taskLabel,
    labelKey: TASK_LABEL_KEY,
    repository: options.repository,
    status,
    exitCode,
    filesystem,
    git,
    docker,
    notes,
  }
}

export async function main(argv: string[]): Promise<number> {
  const parsed = parseAuditArgs(argv)
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n\n${USAGE}\n`)
    return EXIT_USAGE
  }
  if (parsed.value.help) {
    process.stdout.write(`${USAGE}\n`)
    return EXIT_COMPLETE
  }
  const environment: AuditEnvironment = {
    run: runCommand,
    capacity: readCapacity,
    now: () => new Date(),
  }
  const report = await buildReport(parsed.value, environment)
  process.stdout.write(
    `${JSON.stringify(report, null, parsed.value.pretty ? 2 : 0)}\n`,
  )
  return report.exitCode
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
