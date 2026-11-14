// Pure, side-effect free pieces of the final RTC qualification. Everything
// here is covered by tests/node/kobralink-rtc-runner.test.ts.

/** Isolated scenario worlds. Each one owns a fresh database, bridge and printer. */
export const WORLDS = [
  'positive',
  'think-time',
  'lost-reply',
  'late-ack',
  'authority',
  'account-switch',
  'credential-expiry',
] as const
export type World = (typeof WORLDS)[number]

export function parseWorld(value: string | undefined): World {
  const found = WORLDS.find((world) => world === value)
  if (!found) throw new Error('Unknown qualification world')
  return found
}

/** Subset selection for diagnosis only; a final report needs every world. */
export function selectWorlds(value: string | undefined): readonly World[] {
  if (value === undefined || value === '') return WORLDS
  const names = value.split(',')
  const selected = names.map((name) => parseWorld(name))
  if (new Set(selected).size !== selected.length)
    throw new Error('Duplicate qualification world')
  return WORLDS.filter((world) => selected.includes(world))
}

export const QUALIFICATIONS = [
  'first_registration_without_device_id',
  'single_ui',
  'inventory_before_live',
  'reload_reconnect_no_duplicate',
  'lost_ack_recovery',
  'late_ack_fresh_authority',
  'revoked_authority_refused',
  'account_switch_isolated',
  'browser_secrets_absent',
  'mobile_keyboard_accessibility',
  'stale_error_capabilities',
  'resource_cleanup',
] as const
export type Qualification = (typeof QUALIFICATIONS)[number]

/**
 * Coordinator acceptance addition: normal user think-time through a real
 * Connector inbox renewal and near proof rotation. It is not one of the twelve
 * gate keys, but a failure keeps the overall status from passing.
 */
export const ADDITIONAL = ['think_time_lease_renewal'] as const
export type Additional = (typeof ADDITIONAL)[number]

export type CheckRecord = Readonly<{
  world: World | 'runner'
  qualification: Qualification | Additional
  id: string
  ok: boolean
  detail?: string
}>

/** Checks every qualification must contain at least once to count as executed. */
export const REQUIRED_CHECKS: Readonly<
  Record<Qualification | Additional, readonly string[]>
> = {
  first_registration_without_device_id: [
    'device-id-left-empty',
    'identity-observed-before-commit',
    'confirmed-heading',
  ],
  single_ui: ['no-foreign-pages', 'no-iframe'],
  inventory_before_live: [
    'collector-stopped-before-inventory',
    'local-commit-unconfirmed-then-activated',
    'live-authenticated-idle',
  ],
  reload_reconnect_no_duplicate: [
    'reload-preserves-counts',
    'reconnect-preserves-counts',
    'connector-restart-preserves-counts',
    'repeat-registration-refused-without-duplicate',
  ],
  lost_ack_recovery: [
    'reply-lost-unconfirmed',
    'reload-restores-pending-operation',
    'reconcile-confirms-same-operation',
    'no-duplicate-after-lost-reply',
  ],
  late_ack_fresh_authority: [
    'server-registered-connector-unconfirmed',
    'expired-transport-proof-refused',
    'old-ack-without-admitted-status-refused',
    'old-ack-on-new-transport-refused',
    'fresh-status-then-ack-confirms',
    'no-duplicate-after-late-ack',
  ],
  revoked_authority_refused: [
    'owner-write-succeeds',
    'admin-write-succeeds',
    'viewer-refused',
    'revoked-membership-refused',
    'revoked-browser-key-refused',
    'revoked-connector-refused',
    'expired-credential-refused-enrollment-approved',
    'credential-only-revocation-unreachable-by-schema',
    'denied-cases-add-nothing',
  ],
  account_switch_isolated: [
    'pending-restored-for-owner',
    'pending-hidden-from-other-account',
    'forged-restore-refused',
    'owner-keeps-own-operation',
  ],
  browser_secrets_absent: [
    'secret-set-non-empty',
    'responses-clean',
    'storage-clean',
    'console-clean',
    'dom-clean',
    'websocket-clean',
    'browser-inspection-complete',
    'no-unexpected-console-errors',
    'no-unexpected-network-errors',
  ],
  mobile_keyboard_accessibility: [
    'mobile-form-keyboard-only',
    'mobile-identity-confirm-commit',
    'mobile-live-view',
    'mobile-error-state',
    'desktop-error-state',
    'focus-visible',
    'controls-labelled',
    'no-horizontal-overflow',
    'screenshots-captured',
  ],
  stale_error_capabilities: [
    'unknown-before-first-state',
    'offline-reported-truthfully',
    'stale-after-connector-stop',
    'kobra-controls-absent',
    'kobra-camera-absent',
    'capabilities-declared-unavailable',
  ],
  resource_cleanup: [
    'containers-removed',
    'network-removed',
    'private-material-removed',
    'vm-stopped',
    'global-context-preserved',
  ],
  think_time_lease_renewal: [
    'renewal-observed-during-think-time',
    'prepare-near-rotation-safe',
    'prepare-refusal-never-reached-connector',
    'prepare-near-rotation-recoverable',
    'commit-near-rotation-safe',
    'commit-near-rotation-recoverable',
    'fresh-admission-after-renewal',
    'no-duplicate-after-think-time',
  ],
}

export type QualificationResult = 'pass' | 'fail' | 'not-executed'

/**
 * A qualification passes only when every required check was actually recorded
 * and no recorded check failed. A missing check is never treated as success.
 */
export function aggregate(records: readonly CheckRecord[]) {
  const results = {} as Record<Qualification | Additional, QualificationResult>
  const failures: CheckRecord[] = []
  const missing: { qualification: string; id: string }[] = []
  for (const name of [...QUALIFICATIONS, ...ADDITIONAL]) {
    const own = records.filter((record) => record.qualification === name)
    const failed = own.filter((record) => !record.ok)
    const absent = REQUIRED_CHECKS[name].filter(
      (id) => !own.some((record) => record.id === id),
    )
    failures.push(...failed)
    for (const id of absent) missing.push({ qualification: name, id })
    results[name] = failed.length
      ? 'fail'
      : absent.length
        ? 'not-executed'
        : 'pass'
  }
  const status: 'pass' | 'fail' = Object.values(results).every(
    (result) => result === 'pass',
  )
    ? 'pass'
    : 'fail'
  return { status, results, failures, missing }
}

export type Lease = Readonly<{ issuedAt: number; expiresAt: number }>

/**
 * Where a browser `config.begin` lands relative to the Connector inbox lease.
 * `minContextMs` mirrors the production constant; it is never changed here.
 */
export function leasePhase(
  lease: Lease | null,
  now: number,
  minContextMs: number,
): 'offline' | 'admissible' | 'near-rotation' {
  if (!lease || now >= lease.expiresAt || now < lease.issuedAt) return 'offline'
  return lease.expiresAt - now >= minContextMs ? 'admissible' : 'near-rotation'
}

export type Secret = Readonly<{ label: string; value: string }>

const SENSITIVE_KEY =
  /pass|secret|token|cookie|session|private|credential|authorization|api.?key|mqtt/i

const PUBLIC_IDENTIFIER = /(^|_)jti$/

/** Collects string leaves stored under credential-like keys. Values stay in memory. */
export function sensitiveLeaves(
  value: unknown,
  source: string,
  path: readonly string[] = [],
  out: Secret[] = [],
  depth = 0,
): Secret[] {
  if (depth > 12 || out.length >= 256) return out
  if (typeof value === 'string') {
    // A `*_jti` is the public identifier of a credential: it is part of every
    // session binding the browser legitimately holds, and grants nothing.
    const leaf = path[path.length - 1] ?? ''
    if (
      value.length >= 8 &&
      !PUBLIC_IDENTIFIER.test(leaf) &&
      path.some((key) => SENSITIVE_KEY.test(key))
    )
      out.push({ label: `${source}:${path.join('.')}`, value })
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value)
      sensitiveLeaves(item, source, path, out, depth + 1)
    return out
  }
  if (value && typeof value === 'object')
    for (const [key, item] of Object.entries(value))
      sensitiveLeaves(item, source, [...path, key], out, depth + 1)
  return out
}

/** Labels of the secrets present in `text`. Never returns a secret value. */
export function findSecrets(
  text: string,
  secrets: readonly Secret[],
): readonly string[] {
  const hits = new Set<string>()
  for (const secret of secrets)
    if (secret.value.length >= 8 && text.includes(secret.value))
      hits.add(secret.label)
  return [...hits].sort()
}

/** Replaces opaque identifiers so paths can be compared and published. */
export function normalizePath(path: string): string {
  return path
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
      ':id',
    )
    .slice(0, 160)
}

const CLOSED_WHILE_CONNECTING =
  /^WebSocket connection to 'wss:\/\/[^/']+(\/api\/signalling\/(?:config-)?browser)' failed: WebSocket is closed before the connection is established\.$/

/**
 * Console issues not explained by an exact, page-initiated transition. A
 * Chromium "closed before the connection is established" warning is explained
 * only when it is a `warning` for a signalling path and is paired one-to-one
 * with a recorded close() the same page made on a CONNECTING socket of that
 * path. Any other text, type, path, page or an unpaired surplus stays
 * unexplained.
 */
export function unexplainedConsoleIssues<
  T extends Readonly<{ page: string; type: string; text: string }>,
>(
  issues: readonly T[],
  closes: readonly Readonly<{ page: string; path: string }>[],
): T[] {
  const budget = new Map<string, number>()
  for (const close of closes) {
    const key = `${close.page}\0${close.path}`
    budget.set(key, (budget.get(key) ?? 0) + 1)
  }
  return issues.filter((issue) => {
    const path =
      issue.type === 'warning'
        ? CLOSED_WHILE_CONNECTING.exec(issue.text)?.[1]
        : undefined
    if (!path) return true
    const key = `${issue.page}\0${path}`
    const left = budget.get(key) ?? 0
    if (left === 0) return true
    budget.set(key, left - 1)
    return false
  })
}

/** What became of one response body the browser was sent. */
export type BodyOutcome = 'read' | 'bodyless' | 'aborted' | 'unread'

/** Responses that carry no body by protocol; there is nothing to read. */
export function expectsBody(method: string, status: number): boolean {
  if (method.toUpperCase() === 'HEAD') return false
  if (status < 200 || status === 204 || status === 205) return false
  return status !== 304
}

/**
 * Classifies one observed response for the browser audit. Only a browser
 * abort (`net::ERR_ABORTED`, a superseded load) bound to this same request
 * excuses a body that could not be read, and never for a 3xx redirect; every other body-bearing response that was not read stays `unread`
 * and fails the audit.
 */
export function classifyBody(input: {
  method: string
  status: number
  bodyRead: boolean
  failure: string | null
}): BodyOutcome {
  if (input.bodyRead) return 'read'
  if (!expectsBody(input.method, input.status)) return 'bodyless'
  // A redirect hop is never the superseded load itself: its body stays owed.
  if (input.status >= 300 && input.status < 400) return 'unread'
  return input.failure === 'net::ERR_ABORTED' ? 'aborted' : 'unread'
}

/**
 * Strict reading of a committed report: status `pass`, a complete run, all
 * twelve qualifications and the think-time addition `pass`. Returns every
 * reason it is not acceptable; an empty list is the only acceptance.
 */
export function verifyReport(report: unknown): string[] {
  const problems: string[] = []
  if (!report || typeof report !== 'object') return ['report is not an object']
  const value = report as Record<string, unknown>
  if (value.status !== 'pass')
    problems.push(`status is ${String(value.status)}`)
  if (value.complete !== true) problems.push('run did not cover every world')
  const qualifications =
    value.qualifications && typeof value.qualifications === 'object'
      ? (value.qualifications as Record<string, unknown>)
      : {}
  for (const name of QUALIFICATIONS)
    if (qualifications[name] !== 'pass')
      problems.push(`${name} is ${String(qualifications[name] ?? 'absent')}`)
  const additional =
    value.additional && typeof value.additional === 'object'
      ? (value.additional as Record<string, unknown>)
      : {}
  for (const name of ADDITIONAL)
    if (additional[name] !== 'pass')
      problems.push(`${name} is ${String(additional[name] ?? 'absent')}`)
  return problems
}
