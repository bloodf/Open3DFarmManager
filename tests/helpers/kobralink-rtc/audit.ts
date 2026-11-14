import { execFile } from 'node:child_process'
import { appendFile, readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import postgres from 'postgres'
import {
  sensitiveLeaves,
  type Additional,
  type CheckRecord,
  type Qualification,
  type Secret,
  type World,
} from './qualification.ts'

const exec = promisify(execFile)
const CONTEXT = 'colima-openfarm-kobralink-togiej'

/** Append-only record of what was actually executed and observed. */
export function createChecks(directory: string, world: World) {
  const records: CheckRecord[] = []
  return {
    records,
    async record(
      qualification: Qualification | Additional,
      id: string,
      ok: boolean,
      detail?: string,
    ) {
      const entry: CheckRecord = {
        world,
        qualification,
        id,
        ok,
        ...(detail ? { detail: detail.slice(0, 400) } : {}),
      }
      records.push(entry)
      await appendFile(
        join(directory, 'checks.jsonl'),
        JSON.stringify(entry) + '\n',
        { mode: 0o600 },
      )
      return ok
    },
  }
}
export type Checks = ReturnType<typeof createChecks>

export type HarnessSecrets = Readonly<{
  bridgeSecret: string
  printerPassword: string
  bridgeContainer: string
  printerContainer: string
}>

/** Private per-world material written by the runner; never sent to Nitro. */
export async function readHarnessSecrets(
  directory: string,
): Promise<HarnessSecrets> {
  const parsed: unknown = JSON.parse(
    await readFile(join(directory, 'harness-private.json'), 'utf8'),
  )
  if (!parsed || typeof parsed !== 'object')
    throw new Error('Harness private material unavailable')
  const value = parsed as Record<string, unknown>
  const text = (key: string) => {
    const item = value[key]
    if (typeof item !== 'string' || !item)
      throw new Error('Harness private material incomplete')
    return item
  }
  return {
    bridgeSecret: text('bridgeSecret'),
    printerPassword: text('printerPassword'),
    bridgeContainer: text('bridgeContainer'),
    printerContainer: text('printerContainer'),
  }
}

async function jsonFiles(directory: string, depth = 0): Promise<string[]> {
  if (depth > 3) return []
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  )
  const found: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...(await jsonFiles(path, depth + 1)))
    else if (entry.isFile() && entry.name.endsWith('.json')) found.push(path)
  }
  return found.slice(0, 64)
}

/**
 * Printer and bridge credentials the browser must never see: the bridge
 * signing secret, the printer's MQTT identity, the management origin, and
 * every credential-like value in the Connector's private state.
 */
export async function collectSecrets(input: {
  root: string
  harness: HarnessSecrets
  kobraPort: number
}): Promise<Secret[]> {
  const secrets: Secret[] = [
    { label: 'bridge:auth-secret', value: input.harness.bridgeSecret },
    { label: 'printer:mqtt-password', value: input.harness.printerPassword },
    { label: 'printer:mqtt-username', value: 'synthetic-only' },
    {
      label: 'bridge:management-origin',
      value: `127.0.0.1:${input.kobraPort}`,
    },
  ]
  const files = [
    ...(await jsonFiles(join(input.root, 'state'))),
    join(input.root, 'runtime.json'),
    join(input.root, 'credential.json'),
  ]
  for (const file of files) {
    try {
      const info = await stat(file)
      if (!info.isFile() || info.size > 262_144) continue
      const name = file.slice(input.root.length + 1)
      sensitiveLeaves(
        JSON.parse(await readFile(file, 'utf8')),
        name,
        [],
        secrets,
      )
    } catch {
      /* Absent or non-JSON private files contribute nothing. */
    }
  }
  const seen = new Set<string>()
  return secrets.filter((secret) => {
    if (seen.has(secret.value)) return false
    seen.add(secret.value)
    return true
  })
}

/** Rows in the bridge's own printer table, read inside the owned container. */
export async function bridgePrinterCount(container: string): Promise<number> {
  const script = `import{Database}from'bun:sqlite';const d=new Database('/data/kobralink.db');const t=d.query("select name from sqlite_master where type='table'").all().map(r=>r.name);const p=t.find(n=>/^printers?$/i.test(n));console.log(JSON.stringify({tables:t.length,count:p?d.query('select count(*) as n from "'+p+'"').get().n:null}))`
  const { stdout } = await exec(
    'docker',
    ['--context', CONTEXT, 'exec', container, 'bun', '-e', script],
    { timeout: 20_000, maxBuffer: 65_536 },
  )
  const parsed: unknown = JSON.parse(stdout.trim().split('\n').pop() ?? '{}')
  const count =
    parsed && typeof parsed === 'object' && 'count' in parsed
      ? parsed.count
      : null
  if (typeof count !== 'number')
    throw new Error('Bridge printer table not found')
  return count
}

/** Sends a signal to the synthetic printer process (MQTT stop/start only). */
export async function signalPrinter(
  container: string,
  signal: 'SIGUSR1' | 'SIGUSR2',
) {
  await exec(
    'docker',
    ['--context', CONTEXT, 'kill', '--signal', signal, container],
    { timeout: 20_000 },
  )
}

/** Kobra printers the Connector committed to its own runtime file. */
export async function runtimePrinterCount(root: string): Promise<number> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(root, 'runtime.json'), 'utf8'),
    )
    const printers = (
      parsed as { collection?: { kobralink?: { printers?: unknown } } }
    )?.collection?.kobralink?.printers
    return Array.isArray(printers) ? printers.length : 0
  } catch {
    return 0
  }
}

/** Read-only audit of the real database, plus the fixture's only direct writes. */
export function createDatabaseAudit(port: number) {
  const sql = postgres({
    host: '127.0.0.1',
    port,
    database: 'fixture',
    username: 'fixture',
    max: 1,
    connect_timeout: 3,
    connection: { statement_timeout: 5000 },
  })
  const count = async (query: Promise<readonly { n: number }[]>) =>
    Number((await query)[0]?.n ?? -1)
  return {
    async counts(farmId: string) {
      return {
        assignments: await count(
          sql`SELECT count(*)::int AS n FROM farm.printer_assignments WHERE farm_id=${farmId}::uuid`,
        ),
        receipts: await count(
          sql`SELECT count(*)::int AS n FROM farm.configuration_receipts`,
        ),
        operations: await count(
          sql`SELECT count(*)::int AS n FROM farm.configuration_operations`,
        ),
      }
    },
    async connector(agentId: string) {
      const enrollment =
        await sql`SELECT status FROM farm.connector_enrollments WHERE agent_id=${agentId}::uuid`
      const credential =
        await sql`SELECT expires_at::float8 AS expires_at FROM farm.connector_credentials WHERE agent_id=${agentId}::uuid`
      return {
        enrollment: String(enrollment[0]?.status ?? 'absent'),
        credentialExpiresAtMs: Number(credential[0]?.expires_at ?? 0) * 1000,
        revocations: await count(
          sql`SELECT count(*)::int AS n FROM farm.connector_revocations WHERE agent_id=${agentId}::uuid`,
        ),
        credentialTombstones: await count(
          sql`SELECT count(*)::int AS n FROM farm.connector_revocations WHERE agent_id=${agentId}::uuid AND credential_jti IS NOT NULL`,
        ),
      }
    },
    /**
     * Failure-only snapshot of the persisted inputs the configuration
     * bootstrap authority reads, as fixed booleans, counts and millisecond
     * deltas against the database clock. Never a key, token, fingerprint,
     * cookie or body value.
     */
    async authoritySnapshot(input: {
      farmId: string
      agentId: string
      accountId: string
      keyId: string
    }) {
      const hostBefore = Date.now()
      const clock =
        await sql`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::float8 AS now`
      const hostAfter = Date.now()
      const dbNow = Number(clock[0]?.now ?? NaN)
      const ms = (value: unknown, scale = 1) =>
        value === null || value === undefined
          ? null
          : Math.round(Number(value) * scale - dbNow)
      const members =
        await sql`SELECT role,revoked_at FROM farm.memberships WHERE farm_id=${input.farmId}::uuid AND account_id=${input.accountId}`
      const keys = input.keyId
        ? await sql`SELECT farm_id,account_id,status,approved_at,revoked_at FROM farm.browser_device_keys WHERE key_id=${input.keyId}::uuid`
        : []
      const enrollments =
        await sql`SELECT farm_id,status,fingerprint FROM farm.connector_enrollments WHERE agent_id=${input.agentId}::uuid`
      const credentials =
        await sql`SELECT jti,farm_id,fingerprint,issued_at::float8 AS issued_at,expires_at::float8 AS expires_at FROM farm.connector_credentials WHERE agent_id=${input.agentId}::uuid`
      const credential = credentials[0]
      const slots = credential
        ? await sql`SELECT observed_at::float8 AS observed_at,credential_expired_at FROM farm.connector_credential_proofs WHERE jti=${credential.jti}::uuid`
        : []
      const key = keys[0]
      const member = members[0]
      const enrollment = enrollments[0]
      return {
        dbMinusHostMs: Math.round(dbNow - (hostBefore + hostAfter) / 2),
        hostRoundTripMs: hostAfter - hostBefore,
        members: members.length,
        memberRoleAllowed: member?.role === 'owner' || member?.role === 'admin',
        memberRevoked: member ? member.revoked_at !== null : null,
        keyRows: keys.length,
        keyFarmMatches: key ? key.farm_id === input.farmId : null,
        keyAccountMatches: key ? key.account_id === input.accountId : null,
        keyApproved: key ? key.status === 'approved' : null,
        keyApprovedAtMs: ms(key?.approved_at),
        keyRevoked: key ? key.revoked_at !== null : null,
        enrollments: enrollments.length,
        enrollmentApproved: enrollment
          ? enrollment.status === 'approved'
          : null,
        enrollmentFarmMatches: enrollment
          ? enrollment.farm_id === input.farmId
          : null,
        credentials: credentials.length,
        credentialFarmMatches: credential
          ? credential.farm_id === input.farmId
          : null,
        credentialFingerprintMatchesEnrollment:
          credential && enrollment
            ? credential.fingerprint === enrollment.fingerprint
            : null,
        credentialIssuedAtMs: ms(credential?.issued_at, 1000),
        credentialExpiresAtMs: ms(credential?.expires_at, 1000),
        credentialSlots: slots.length,
        credentialSlotObservedAtMs: ms(slots[0]?.observed_at),
        credentialExpiredRecorded: slots[0]
          ? slots[0].credential_expired_at !== null
          : null,
        revocations: await count(
          sql`SELECT count(*)::int AS n FROM farm.connector_revocations WHERE agent_id=${input.agentId}::uuid OR credential_jti=${credential?.jti ?? null}::uuid`,
        ),
      }
    },
    async browserKeyStatus(keyId: string) {
      const rows =
        await sql`SELECT status FROM farm.browser_device_keys WHERE key_id=${keyId}::uuid`
      return String(rows[0]?.status ?? 'absent')
    },
    /**
     * The product has no membership-revocation endpoint. The tombstone is
     * written through the table's own lifecycle trigger, as an operator would.
     */
    async revokeMembership(farmId: string, accountId: string) {
      const rows =
        await sql`UPDATE farm.memberships SET revoked_at=${Date.now()} WHERE farm_id=${farmId}::uuid AND account_id=${accountId} AND revoked_at IS NULL RETURNING role`
      return rows.length === 1
    },
    /**
     * Negative schema assertion on the real database: a tombstone for the
     * issued credential while its enrollment is still approved. The table's
     * lifecycle trigger must reject it. Always rolled back; nothing is kept.
     */
    async credentialOnlyTombstone(agentId: string, accountId: string) {
      const before = await count(
        sql`SELECT count(*)::int AS n FROM farm.connector_revocations`,
      )
      let rejected = ''
      let inserted = false
      try {
        await sql.begin(async (tx) => {
          await tx`INSERT INTO farm.connector_revocations(agent_id,farm_id,fingerprint,credential_jti,revoked_at,revoked_by) SELECT c.agent_id,c.farm_id,c.fingerprint,c.jti,${Date.now()},${accountId} FROM farm.connector_credentials c WHERE c.agent_id=${agentId}::uuid`
          inserted = true
          throw new Error('rollback')
        })
      } catch (error) {
        rejected =
          error instanceof postgres.PostgresError
            ? `${error.code}: ${error.message}`.slice(0, 120)
            : ''
      }
      const after = await count(
        sql`SELECT count(*)::int AS n FROM farm.connector_revocations`,
      )
      const enrollment =
        await sql`SELECT status FROM farm.connector_enrollments WHERE agent_id=${agentId}::uuid`
      return {
        inserted,
        rejected,
        unchanged: before === after,
        enrollment: String(enrollment[0]?.status ?? 'absent'),
      }
    },
    close: () => sql.end({ timeout: 3 }),
  }
}
export type DatabaseAudit = ReturnType<typeof createDatabaseAudit>
