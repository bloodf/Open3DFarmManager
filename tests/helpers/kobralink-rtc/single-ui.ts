import { createHash } from 'node:crypto'
import type { CheckRecord } from './qualification.ts'

/**
 * Single-interface acceptance: one real run of the positive world registers
 * a synthetic Kobra X entirely from the Open3dFarm interface, confirms
 * authenticated inventory and current telemetry, keeps printer and bridge
 * secrets out of the browser and leaves no owned runtime behind. Other
 * recorded checks are kept in the result but not required.
 */
export const SINGLE_UI_REQUIRED = [
  'first_registration_without_device_id/device-id-left-empty',
  'first_registration_without_device_id/identity-observed-before-commit',
  'first_registration_without_device_id/confirmed-heading',
  'single_ui/no-foreign-pages',
  'single_ui/no-iframe',
  'inventory_before_live/collector-stopped-before-inventory',
  'inventory_before_live/local-commit-unconfirmed-then-activated',
  'inventory_before_live/live-authenticated-idle',
  'browser_secrets_absent/secret-set-non-empty',
  'browser_secrets_absent/responses-clean',
  'browser_secrets_absent/storage-clean',
  'browser_secrets_absent/console-clean',
  'browser_secrets_absent/dom-clean',
  'browser_secrets_absent/websocket-clean',
  'resource_cleanup/containers-removed',
  'resource_cleanup/network-removed',
  'resource_cleanup/private-material-removed',
  'resource_cleanup/vm-stopped',
  'resource_cleanup/global-context-preserved',
] as const

/** Retained files whose content the result is derived from. */
export const SINGLE_UI_SOURCES = [
  'final-report.json',
  'positive/checks.jsonl',
  'runner-checks.jsonl',
] as const

const HEX64 = /^[0-9a-f]{64}$/
const HEX40 = /^[0-9a-f]{40}$/
const RUN = /^[0-9a-f-]{36}$/

const key = (record: Pick<CheckRecord, 'qualification' | 'id'>) =>
  `${record.qualification}/${record.id}`

export type SingleUiResult = Readonly<{
  acceptance: 'kobra-x-single-ui'
  status: 'pass' | 'fail'
  head: string
  run: string
  sourceSha256: string
  outputSha256: string
  evidenceManifestSha256: string
  positiveExit: number
  required: readonly { check: string; ok: boolean | null }[]
  recorded: readonly { check: string; ok: boolean }[]
}>

/** Hash lines of `evidence.sha256` keyed by retained relative path. */
export function parseManifest(text: string): Map<string, string> {
  const entries = new Map<string, string>()
  for (const line of text.split('\n').filter(Boolean)) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line)
    if (!match) throw new Error('malformed evidence manifest line')
    entries.set(match[2]!, match[1]!)
  }
  return entries
}

/**
 * Derives the committed result from the retained files of one actual run.
 * Every source file must match the run's own hash manifest, so the result
 * cannot be assembled from edited or foreign artifacts.
 */
export function buildSingleUiResult(input: {
  manifest: string
  files: Readonly<Record<(typeof SINGLE_UI_SOURCES)[number], string>>
}): SingleUiResult {
  const manifest = parseManifest(input.manifest)
  for (const name of SINGLE_UI_SOURCES) {
    const digest = createHash('sha256').update(input.files[name]).digest('hex')
    if (manifest.get(name) !== digest)
      throw new Error(`${name} does not match the run manifest`)
  }
  const report = JSON.parse(input.files['final-report.json']) as Record<
    string,
    unknown
  >
  const worlds = (report.worlds ?? {}) as Record<string, { exit?: unknown }>
  const records = [
    ...input.files['positive/checks.jsonl'].split('\n'),
    ...input.files['runner-checks.jsonl'].split('\n'),
  ]
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CheckRecord)
  const outcomes = new Map<string, boolean>()
  for (const record of records)
    // One failed repetition fails the check.
    outcomes.set(key(record), (outcomes.get(key(record)) ?? true) && record.ok)
  const positiveExit =
    typeof worlds.positive?.exit === 'number' ? worlds.positive.exit : -1
  const required = SINGLE_UI_REQUIRED.map((check) => ({
    check,
    ok: outcomes.get(check) ?? null,
  }))
  const pass = positiveExit === 0 && required.every((r) => r.ok === true)
  return {
    acceptance: 'kobra-x-single-ui',
    status: pass ? 'pass' : 'fail',
    head: String(report.head),
    run: String(report.run),
    sourceSha256: String(report.sourceSha256),
    outputSha256: String(report.outputSha256),
    evidenceManifestSha256: createHash('sha256')
      .update(input.manifest)
      .digest('hex'),
    positiveExit,
    required,
    recorded: [...outcomes].map(([check, ok]) => ({ check, ok })),
  }
}

/** Static checks of a committed result; source binding is checked by git. */
export function verifySingleUi(result: unknown): string[] {
  if (!result || typeof result !== 'object') return ['result is not an object']
  const value = result as Record<string, unknown>
  const problems: string[] = []
  if (value.acceptance !== 'kobra-x-single-ui')
    problems.push('not a single-interface result')
  if (value.status !== 'pass')
    problems.push(`status is ${String(value.status)}`)
  if (typeof value.head !== 'string' || !HEX40.test(value.head))
    problems.push('head is not a commit')
  if (typeof value.run !== 'string' || !RUN.test(value.run))
    problems.push('run id is invalid')
  for (const field of [
    'sourceSha256',
    'outputSha256',
    'evidenceManifestSha256',
  ] as const)
    if (typeof value[field] !== 'string' || !HEX64.test(value[field] as string))
      problems.push(`${field} is not a SHA-256`)
  if (value.positiveExit !== 0)
    problems.push(`positive world exit ${String(value.positiveExit)}`)
  const required = Array.isArray(value.required)
    ? (value.required as { check?: unknown; ok?: unknown }[])
    : []
  const recorded = new Map(
    (Array.isArray(value.recorded)
      ? (value.recorded as { check?: unknown; ok?: unknown }[])
      : []
    ).map((r) => [r.check, r.ok]),
  )
  for (const check of SINGLE_UI_REQUIRED) {
    const entry = required.find((r) => r.check === check)
    if (entry?.ok !== true)
      problems.push(`${check} is ${String(entry?.ok ?? 'absent')}`)
    else if (recorded.get(check) !== true)
      problems.push(`${check} is not among the recorded checks`)
  }
  return problems
}
