import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { SignedCommandV2 } from '../../../farm-protocol/src/command-v2.ts'
import { BrowserDeviceUuid } from '../../../farm-protocol/src/browser-device-proof.ts'
import { canonicalize } from '../../../farm-protocol/src/canonical.ts'

const RETENTION_MS = 600_000
const MAX_CAPACITY = 10_000
const APPLICATION_ID = 0x4f334450
const SCHEMA_VERSION = 1
const reasons = [
  'guard-denied',
  'rpc-rejected',
  'rpc-acknowledged',
  'rpc-unknown',
  'state-unconfirmed',
  'deadline',
  'aborted',
  'driver-contract',
  'storage',
  'dispatcher-closed',
  'applied',
  'not-sent',
  'outcome-unknown',
] as const
const Reason = z.enum(reasons)
export type CommandJournalReason = z.infer<typeof Reason>
export type CommandJournalOutcome = 'not-sent' | 'applied' | 'outcome-unknown'
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const printerKey = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => {
    try {
      canonicalize(value)
      return !value.includes('\0')
    } catch {
      return false
    }
  })
const ClaimInput = z.strictObject({
  command: SignedCommandV2,
  printerKey,
  wireSha256: z.string().regex(/^[0-9a-f]{64}$/),
})
const OutcomeRow = z.strictObject({
  cmdId: BrowserDeviceUuid,
  assignmentId: BrowserDeviceUuid,
  farmId: BrowserDeviceUuid,
  printerKey,
  status: z.enum([
    'claimed',
    'write-started',
    'not-sent',
    'applied',
    'outcome-unknown',
  ]),
  reason: Reason.nullable(),
  claimedAt: time,
  writeStartedAt: time.nullable(),
  finishedAt: time.nullable(),
})
export type BoundedCommandOutcome = Readonly<
  Omit<z.infer<typeof OutcomeRow>, 'status'> & { status: CommandJournalOutcome }
>
class JournalHandle {
  #opaque = true
  constructor() {
    Object.freeze(this)
  }
  toJSON(): never {
    throw new Error('Command journals cannot be serialized')
  }
}
class ClaimHandle {
  #opaque = true
  constructor() {
    Object.freeze(this)
  }
  toJSON(): never {
    throw new Error('Command receipts cannot be serialized')
  }
}
Object.freeze(JournalHandle.prototype)
Object.freeze(ClaimHandle.prototype)
export type CommandJournalHandle = JournalHandle
export type CommandClaimHandle = ClaimHandle
export type CommandClaimResult =
  | { ok: true; receipt: CommandClaimHandle }
  | {
      ok: false
      reason:
        | 'replay'
        | 'assignment-busy'
        | 'capacity'
        | 'rate-limited'
        | 'clock-regressed'
        | 'storage-unavailable'
    }
type State = {
  database: DatabaseSync
  directory: string
  path: string
  clock: () => number
  capacity: number
  writerId: string
  closed: boolean
}
type Receipt = {
  journal: State
  cmdId: string
  markAttempted: boolean
  marked: boolean
  finishAttempted: boolean
}
const journals = new WeakMap<JournalHandle, State>()
const receipts = new WeakMap<ClaimHandle, Receipt>()

const schema = [
  `CREATE TABLE pause_meta (id INTEGER PRIMARY KEY CHECK(id=1), high_water INTEGER NOT NULL CHECK(high_water BETWEEN 0 AND 9007199254140991)) STRICT`,
  `CREATE TABLE pause_commands (
    cmd_id TEXT PRIMARY KEY, key_id TEXT NOT NULL, nonce TEXT NOT NULL,
    farm_id TEXT NOT NULL, agent_id TEXT NOT NULL, assignment_id TEXT NOT NULL,
    account_id TEXT NOT NULL, transport_id TEXT NOT NULL, capability_id TEXT NOT NULL,
    printer_key TEXT NOT NULL, wire_sha256 TEXT NOT NULL, writer_id TEXT NOT NULL,
    claimed_at INTEGER NOT NULL, write_started_at INTEGER, finished_at INTEGER,
    status TEXT NOT NULL CHECK(status IN ('claimed','write-started','not-sent','applied','outcome-unknown')),
    reason TEXT CHECK(reason IN (${reasons.map((r) => "'" + r + "'").join(',')})), retain_until INTEGER,
    UNIQUE(key_id,nonce),
    CHECK(claimed_at BETWEEN 0 AND 9007199254140991),
    CHECK(write_started_at IS NULL OR write_started_at BETWEEN claimed_at AND 9007199254140991),
    CHECK((status='claimed' AND write_started_at IS NULL AND finished_at IS NULL AND reason IS NULL AND retain_until IS NULL)
       OR (status='write-started' AND write_started_at IS NOT NULL AND finished_at IS NULL AND reason IS NULL AND retain_until IS NULL)
       OR (status IN ('not-sent','applied','outcome-unknown') AND finished_at BETWEEN claimed_at AND 9007199254140991 AND reason IS NOT NULL
           AND (status<>'applied' OR write_started_at IS NOT NULL)
           AND ((status='outcome-unknown' AND retain_until IS NULL) OR (status IN ('not-sent','applied') AND retain_until=finished_at+600000))))
  ) STRICT`,
  `CREATE UNIQUE INDEX pause_active_assignment ON pause_commands(assignment_id) WHERE status IN ('claimed','write-started','outcome-unknown')`,
  `CREATE UNIQUE INDEX pause_active_printer ON pause_commands(farm_id,printer_key) WHERE status IN ('claimed','write-started','outcome-unknown')`,
  `CREATE INDEX pause_recent_printer ON pause_commands(farm_id,printer_key,claimed_at)`,
  `CREATE INDEX pause_terminal_retention ON pause_commands(retain_until) WHERE status IN ('not-sent','applied')`,
]
function privateEntry(path: string, directory: boolean) {
  const stat = lstatSync(path)
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
    (process.platform !== 'win32' &&
      ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
  )
    throw new Error(
      'Command journal requires current-user private regular storage',
    )
}
function privateStorage(state: Pick<State, 'directory' | 'path'>) {
  privateEntry(state.directory, true)
  for (const suffix of ['', '-wal', '-shm', '-journal'])
    if (lstatSync(state.path + suffix, { throwIfNoEntry: false }))
      privateEntry(state.path + suffix, false)
}
function stateOf(handle: unknown): State | null {
  if (!(handle instanceof JournalHandle)) return null
  const state = journals.get(handle)
  return state && !state.closed ? state : null
}
function sample(state: State): number {
  const now = state.clock()
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    now > Number.MAX_SAFE_INTEGER - RETENTION_MS
  )
    throw new Error('Invalid command journal clock')
  return now
}
function clockStep(state: State): number | null {
  const now = sample(state)
  const row = state.database
    .prepare('SELECT high_water FROM pause_meta WHERE id=1')
    .get()
  if (
    !row ||
    typeof row.high_water !== 'number' ||
    !Number.isSafeInteger(row.high_water) ||
    row.high_water < 0
  )
    throw new Error('Invalid command journal metadata')
  if (now < row.high_water) return null
  state.database
    .prepare('UPDATE pause_meta SET high_water=? WHERE id=1')
    .run(now)
  return now
}
function transaction<T>(state: State, run: () => T): T {
  privateStorage(state)
  state.database.exec('BEGIN IMMEDIATE')
  let committed = false
  try {
    const result = run()
    state.database.exec('COMMIT')
    committed = true
    return result
  } finally {
    if (!committed)
      try {
        state.database.exec('ROLLBACK')
      } catch {
        /* Preserve uncertainty; never manufacture a receipt. */
      }
  }
}
/** Opens only the distinct v2 pause journal. Unknown schemas and unsafe files are not repaired. */
export function openCommandJournal(input: {
  directory: string
  clock: () => number
  capacity?: number
}): CommandJournalHandle {
  const capacity = input.capacity ?? MAX_CAPACITY
  if (
    typeof input.directory !== 'string' ||
    !input.directory ||
    typeof input.clock !== 'function' ||
    !Number.isSafeInteger(capacity) ||
    capacity < 1 ||
    capacity > MAX_CAPACITY
  )
    throw new Error('Invalid command journal configuration')
  mkdirSync(input.directory, { recursive: true, mode: 0o700 })
  privateEntry(input.directory, true)
  const path = join(input.directory, 'pause-commands.sqlite')
  let created = false
  if (!existsSync(path)) {
    try {
      closeSync(openSync(path, 'wx', 0o600))
      created = true
    } catch (error) {
      if (
        !(
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'EEXIST'
        )
      )
        throw error
    }
  }
  privateStorage({ directory: input.directory, path })
  const database = new DatabaseSync(path, {
    timeout: 100,
    allowExtension: false,
  })
  try {
    // Inspect identity before any persistent pragma can alter an unrelated database.
    const initialVersion = database
      .prepare('PRAGMA user_version')
      .get()?.user_version
    const initialApplication = database
      .prepare('PRAGMA application_id')
      .get()?.application_id
    if (
      !(created && initialVersion === 0 && initialApplication === 0) &&
      (initialVersion !== SCHEMA_VERSION ||
        initialApplication !== APPLICATION_ID)
    )
      throw new Error('Unknown command journal version')
    database.exec(
      'PRAGMA trusted_schema=OFF; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;',
    )
    database.exec('BEGIN IMMEDIATE')
    try {
      const version = database
        .prepare('PRAGMA user_version')
        .get()?.user_version
      const app = database
        .prepare('PRAGMA application_id')
        .get()?.application_id
      if (created && version === 0 && app === 0) {
        const count = database
          .prepare(
            "SELECT count(*) AS n FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
          )
          .get()?.n
        if (count !== 0) throw new Error('Unknown command journal schema')
        for (const statement of schema) database.exec(statement)
        database.exec(
          `INSERT INTO pause_meta VALUES(1,0); PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION};`,
        )
      } else if (version !== SCHEMA_VERSION || app !== APPLICATION_ID)
        throw new Error('Unknown command journal version')
      const definitions = database
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY sql",
        )
        .all()
        .map((row) => row.sql)
      if (
        definitions.length !== schema.length ||
        definitions.some((sql, index) => sql !== [...schema].sort()[index])
      )
        throw new Error('Invalid command journal schema')
      const meta = database
        .prepare('SELECT count(*) AS n,min(id) AS id FROM pause_meta')
        .get()
      if (meta?.n !== 1 || meta.id !== 1)
        throw new Error('Invalid command journal metadata')
      database.exec('COMMIT')
    } catch (error) {
      try {
        database.exec('ROLLBACK')
      } catch {}
      throw error
    }
    if (
      database.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'wal' ||
      database.prepare('PRAGMA synchronous').get()?.synchronous !== 2
    )
      throw new Error('Command journal durability unavailable')
    privateStorage({ directory: input.directory, path })
    const handle = new JournalHandle()
    journals.set(handle, {
      database,
      directory: input.directory,
      path,
      clock: input.clock,
      capacity,
      writerId: randomUUID(),
      closed: false,
    })
    return handle
  } catch (error) {
    database.close()
    throw error
  }
}
/** Durable replay and exclusion only. A receipt never authorizes a driver. */
export function claimCommand(
  handle: CommandJournalHandle,
  input: { command: SignedCommandV2; printerKey: string; wireSha256: string },
): CommandClaimResult {
  const state = stateOf(handle)
  if (!state) return { ok: false, reason: 'storage-unavailable' }
  const parsed = ClaimInput.safeParse(input)
  if (!parsed.success) return { ok: false, reason: 'storage-unavailable' }
  try {
    const result = transaction(
      state,
      (): { ok: true } | Exclude<CommandClaimResult, { ok: true }> => {
        const now = clockStep(state)
        if (now === null) return { ok: false, reason: 'clock-regressed' }
        const command = parsed.data.command
        if (now < command.issued_at || now >= command.expires_at)
          return { ok: false, reason: 'storage-unavailable' }
        state.database
          .prepare(
            "DELETE FROM pause_commands WHERE status IN ('not-sent','applied') AND retain_until<=?",
          )
          .run(now)
        if (
          state.database
            .prepare(
              'SELECT 1 FROM pause_commands WHERE cmd_id=? OR (key_id=? AND nonce=?) LIMIT 1',
            )
            .get(command.cmd_id, command.key_id, command.nonce)
        )
          return { ok: false, reason: 'replay' }
        if (
          state.database
            .prepare(
              "SELECT 1 FROM pause_commands WHERE status IN ('claimed','write-started','outcome-unknown') AND (assignment_id=? OR (farm_id=? AND printer_key=?)) LIMIT 1",
            )
            .get(command.assignment_id, command.farm_id, parsed.data.printerKey)
        )
          return { ok: false, reason: 'assignment-busy' }
        const count = state.database
          .prepare('SELECT count(*) AS n FROM pause_commands')
          .get()?.n
        if (typeof count !== 'number') throw new Error('Invalid command count')
        if (count >= state.capacity) return { ok: false, reason: 'capacity' }
        const recent = state.database
          .prepare(
            'SELECT count(*) AS n FROM pause_commands WHERE farm_id=? AND printer_key=? AND claimed_at>?',
          )
          .get(command.farm_id, parsed.data.printerKey, now - 60000)?.n
        if (typeof recent !== 'number') throw new Error('Invalid rate count')
        if (recent >= 10) return { ok: false, reason: 'rate-limited' }
        state.database
          .prepare(
            "INSERT INTO pause_commands(cmd_id,key_id,nonce,farm_id,agent_id,assignment_id,account_id,transport_id,capability_id,printer_key,wire_sha256,writer_id,claimed_at,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'claimed')",
          )
          .run(
            command.cmd_id,
            command.key_id,
            command.nonce,
            command.farm_id,
            command.agent_id,
            command.assignment_id,
            command.account_id,
            command.transport_id,
            command.capability_id,
            parsed.data.printerKey,
            parsed.data.wireSha256,
            state.writerId,
            now,
          )
        return { ok: true }
      },
    )
    if (!result.ok) return result
    const receipt = new ClaimHandle()
    receipts.set(receipt, {
      journal: state,
      cmdId: parsed.data.command.cmd_id,
      markAttempted: false,
      marked: false,
      finishAttempted: false,
    })
    return { ok: true, receipt }
  } catch {
    return { ok: false, reason: 'storage-unavailable' }
  }
}
function receiptOf(state: State, handle: unknown): Receipt | null {
  if (!(handle instanceof ClaimHandle)) return null
  const receipt = receipts.get(handle)
  return receipt && receipt.journal === state && !receipt.finishAttempted
    ? receipt
    : null
}
export function markWriteStarted(
  handle: CommandJournalHandle,
  claim: CommandClaimHandle,
): boolean {
  const state = stateOf(handle),
    receipt = state && receiptOf(state, claim)
  if (!state || !receipt || receipt.markAttempted) return false
  receipt.markAttempted = true
  try {
    const marked = transaction(state, () => {
      const now = clockStep(state)
      if (now === null) return false
      return (
        state.database
          .prepare(
            "UPDATE pause_commands SET status='write-started',write_started_at=? WHERE cmd_id=? AND writer_id=? AND status='claimed'",
          )
          .run(now, receipt.cmdId, state.writerId).changes === 1
      )
    })
    receipt.marked = marked
    return marked
  } catch {
    return false
  }
}
export function finishCommand(
  handle: CommandJournalHandle,
  claim: CommandClaimHandle,
  outcome: CommandJournalOutcome,
  reason: CommandJournalReason,
): boolean {
  const state = stateOf(handle),
    receipt = state && receiptOf(state, claim)
  if (
    !state ||
    !receipt ||
    !['not-sent', 'applied', 'outcome-unknown'].includes(outcome) ||
    !Reason.safeParse(reason).success ||
    (outcome === 'applied' && !receipt.marked)
  )
    return false
  receipt.finishAttempted = true
  try {
    return transaction(state, () => {
      const now = clockStep(state)
      if (now === null) return false
      return (
        state.database
          .prepare(
            "UPDATE pause_commands SET status=?,reason=?,finished_at=?,retain_until=? WHERE cmd_id=? AND writer_id=? AND status IN ('claimed','write-started')",
          )
          .run(
            outcome,
            reason,
            now,
            outcome === 'outcome-unknown' ? null : now + RETENTION_MS,
            receipt.cmdId,
            state.writerId,
          ).changes === 1
      )
    })
  } catch {
    return false
  }
}
/** Claimed and write-started rows remain unresolved, never reconstructed as writable receipts. */
export function readCommandOutcome(
  handle: CommandJournalHandle,
  cmdId: string,
): BoundedCommandOutcome | null {
  const state = stateOf(handle)
  if (!state || !BrowserDeviceUuid.safeParse(cmdId).success) return null
  try {
    return transaction(state, () => {
      if (clockStep(state) === null) return null
      const row = state.database
        .prepare(
          'SELECT cmd_id AS cmdId,assignment_id AS assignmentId,farm_id AS farmId,printer_key AS printerKey,status,reason,claimed_at AS claimedAt,write_started_at AS writeStartedAt,finished_at AS finishedAt FROM pause_commands WHERE cmd_id=?',
        )
        .get(cmdId)
      if (!row) return null
      const parsed = OutcomeRow.parse(row)
      return Object.freeze({
        ...parsed,
        status:
          parsed.status === 'claimed' || parsed.status === 'write-started'
            ? 'outcome-unknown'
            : parsed.status,
      })
    })
  } catch {
    return null
  }
}
export function closeCommandJournal(handle: CommandJournalHandle): void {
  const state = stateOf(handle)
  if (!state) return
  state.closed = true
  state.database.close()
}
