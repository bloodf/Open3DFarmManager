import type { Sql } from 'postgres'
import {
  evaluateSession,
  type AccountSessionState,
  type SessionPolicy,
  type SessionRecord,
} from '../utils/auth/session-contract.ts'
import {
  detectedProfile,
  machineProfileView,
  type MachineProfileAudit,
  type MachineProfileOverride,
  type MachineProfileView,
} from '../utils/machine-profile.ts'
import { inventoryUuid } from './postgres-connector-inventory.ts'

export type PrinterProfileFailure = {
  ok: false
  reason:
    | 'invalid-input'
    | 'unauthorized'
    | 'forbidden'
    | 'denied'
    | 'not-found'
    | 'storage-unavailable'
}
interface Authority {
  sessionRecordId: string
  policy: SessionPolicy
  farmId: string
}
interface StoredRow {
  assignmentId: string
  state: unknown
  profileAssignmentId: string | null
  model: string | null
  nozzleDiameterMm: number | null
  bedSizeXMm: number | null
  bedSizeYMm: number | null
  bedSizeZMm: number | null
  maxHotendTemperatureCelsius: number | null
  maxBedTemperatureCelsius: number | null
  kinematics: string | null
  compatibleModels: string[] | null
  notes: string | null
  updatedBy: string | null
  updatedAt: number | null
}
type Tx = Parameters<Parameters<Sql['begin']>[1]>[0]

function fetchRows(
  tx: Tx,
  farmId: string,
  assignmentId: string | null,
  after: string | null,
  limit: number,
) {
  return tx<
    StoredRow[]
  >`SELECT a.id AS "assignmentId", s.state, p.assignment_id AS "profileAssignmentId", p.model, p.nozzle_diameter_mm AS "nozzleDiameterMm", p.bed_size_x_mm AS "bedSizeXMm", p.bed_size_y_mm AS "bedSizeYMm", p.bed_size_z_mm AS "bedSizeZMm", p.max_hotend_temperature_celsius AS "maxHotendTemperatureCelsius", p.max_bed_temperature_celsius AS "maxBedTemperatureCelsius", p.kinematics, p.compatible_models AS "compatibleModels", p.notes, p.updated_by AS "updatedBy", p.updated_at::float8 AS "updatedAt" FROM farm.printer_assignments a LEFT JOIN farm.printer_latest_state s ON s.farm_id = a.farm_id AND s.agent_id = a.agent_id AND s.printer_key = a.printer_key LEFT JOIN farm.printer_profiles p ON p.assignment_id = a.id WHERE a.farm_id = ${farmId}::uuid AND a.revoked_at IS NULL AND (${assignmentId}::uuid IS NULL OR a.id = ${assignmentId}::uuid) AND (${after}::uuid IS NULL OR a.id > ${after}::uuid) ORDER BY a.id LIMIT ${limit}`
}

function toView(row: StoredRow, canManage: boolean): MachineProfileView {
  const stored: (MachineProfileOverride & MachineProfileAudit) | null =
    row.profileAssignmentId
      ? {
          model: row.model,
          nozzleDiameterMm: row.nozzleDiameterMm,
          bedSizeXMm: row.bedSizeXMm,
          bedSizeYMm: row.bedSizeYMm,
          bedSizeZMm: row.bedSizeZMm,
          maxHotendTemperatureCelsius: row.maxHotendTemperatureCelsius,
          maxBedTemperatureCelsius: row.maxBedTemperatureCelsius,
          kinematics: row.kinematics,
          compatibleModels: row.compatibleModels ?? [],
          notes: row.notes,
          updatedBy: row.updatedBy ?? '',
          updatedAt: row.updatedAt ?? 0,
        }
      : null
  const view = machineProfileView(
    row.assignmentId,
    detectedProfile(row.state),
    stored,
  )
  // Account identifiers of editors are only shown to the people who can edit.
  return canManage ? view : { ...view, updatedBy: null }
}

/**
 * Machine profile overrides per assignment. Any active member reads the
 * effective profile; only owners and admins write the override.
 */
export class PostgresPrinterProfiles {
  private inflight = 0
  private readonly sql: Sql
  private readonly clock: () => number
  constructor(sql: Sql, clock: () => number = Date.now) {
    this.sql = sql
    this.clock = clock
  }

  private validAuthority(input: Authority): boolean {
    return (
      inventoryUuid.test(input.farmId) &&
      /^[A-Za-z0-9_-]{1,128}$/.test(input.sessionRecordId) &&
      Number.isSafeInteger(input.policy.idleTimeoutMs) &&
      input.policy.idleTimeoutMs > 0
    )
  }

  /** Runs one authorized transaction: session, active membership, then the work. */
  private async authorized<T extends { ok: true }>(
    input: Authority,
    mustManage: boolean,
    work: (
      tx: Tx,
      who: { accountId: string; canManage: boolean },
    ) => Promise<T | PrinterProfileFailure>,
  ): Promise<T | PrinterProfileFailure> {
    if (!this.validAuthority(input))
      return { ok: false, reason: 'invalid-input' }
    if (this.inflight >= 32) return { ok: false, reason: 'storage-unavailable' }
    this.inflight++
    try {
      return await this.sql.begin(
        async (tx): Promise<T | PrinterProfileFailure> => {
          await tx`SET LOCAL statement_timeout = '2000ms'`
          await tx`SET LOCAL lock_timeout = '1000ms'`
          const accounts = await tx<
            AccountSessionState[]
          >`SELECT id, session_version::float8 AS "sessionVersion", disabled FROM farm.session_accounts WHERE id = (SELECT account_id FROM farm.account_sessions WHERE id = ${input.sessionRecordId}) FOR SHARE`
          const sessions = await tx<
            SessionRecord[]
          >`SELECT id, account_id AS "accountId", account_version::float8 AS "accountVersion", created_at::float8 AS "createdAt", last_seen_at::float8 AS "lastSeenAt", absolute_expires_at::float8 AS "absoluteExpiresAt", revoked_at::float8 AS "revokedAt" FROM farm.account_sessions WHERE id = ${input.sessionRecordId} FOR UPDATE`
          const firstAt = this.clock()
          const first = evaluateSession(
            input.sessionRecordId,
            sessions[0] ?? null,
            accounts[0] ?? null,
            firstAt,
            input.policy,
          )
          if (!first.ok) return { ok: false, reason: 'unauthorized' }
          const members =
            await tx`SELECT role, revoked_at FROM farm.memberships WHERE farm_id = ${input.farmId}::uuid AND account_id = ${first.accountId} FOR SHARE`
          if (!members[0] || members[0].revoked_at !== null)
            return { ok: false, reason: 'forbidden' }
          const canManage = ['owner', 'admin'].includes(String(members[0].role))
          if (mustManage && !canManage) return { ok: false, reason: 'denied' }
          const result = await work(tx, {
            accountId: first.accountId,
            canManage,
          })
          if (!result.ok) return result
          const now = this.clock()
          const current = evaluateSession(
            input.sessionRecordId,
            sessions[0] ?? null,
            accounts[0] ?? null,
            now,
            input.policy,
          )
          if (now < firstAt || !current.ok)
            return { ok: false, reason: 'unauthorized' }
          await tx`UPDATE farm.account_sessions SET last_seen_at = ${current.touchAt} WHERE id = ${input.sessionRecordId}`
          return result
        },
      )
    } catch {
      return { ok: false, reason: 'storage-unavailable' }
    } finally {
      this.inflight--
    }
  }

  read(
    input: Authority & { assignmentId: string },
  ): Promise<
    | { ok: true; profile: MachineProfileView; canManage: boolean }
    | PrinterProfileFailure
  > {
    if (!inventoryUuid.test(input.assignmentId))
      return Promise.resolve({ ok: false, reason: 'invalid-input' })
    return this.authorized<{
      ok: true
      profile: MachineProfileView
      canManage: boolean
    }>(input, false, async (tx, { canManage }) => {
      const rows = await fetchRows(
        tx,
        input.farmId,
        input.assignmentId,
        null,
        1,
      )
      if (!rows[0]) return { ok: false, reason: 'not-found' }
      return { ok: true, profile: toView(rows[0], canManage), canManage }
    })
  }

  /** Effective profiles of the active printers, served to the library and replay pages. */
  list(input: Authority & { limit: number; after: string | null }): Promise<
    | {
        ok: true
        profiles: MachineProfileView[]
        nextAfter: string | null
        canManage: boolean
      }
    | PrinterProfileFailure
  > {
    if (
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 50 ||
      (input.after !== null && !inventoryUuid.test(input.after))
    )
      return Promise.resolve({ ok: false, reason: 'invalid-input' })
    return this.authorized(input, false, async (tx, { canManage }) => {
      const rows = await fetchRows(
        tx,
        input.farmId,
        null,
        input.after,
        input.limit + 1,
      )
      const page = rows.slice(0, input.limit)
      return {
        ok: true,
        profiles: page.map((row) => toView(row, canManage)),
        nextAfter:
          rows.length > input.limit
            ? (page.at(-1)?.assignmentId ?? null)
            : null,
        canManage,
      }
    })
  }

  edit(
    input: Authority & {
      assignmentId: string
      profile: MachineProfileOverride
    },
  ): Promise<
    | { ok: true; profile: MachineProfileView; canManage: true }
    | PrinterProfileFailure
  > {
    if (!inventoryUuid.test(input.assignmentId))
      return Promise.resolve({ ok: false, reason: 'invalid-input' })
    const p = input.profile
    return this.authorized<{
      ok: true
      profile: MachineProfileView
      canManage: true
    }>(input, true, async (tx, { accountId }) => {
      const assignment =
        await tx`SELECT id FROM farm.printer_assignments WHERE farm_id = ${input.farmId}::uuid AND id = ${input.assignmentId}::uuid AND revoked_at IS NULL FOR SHARE`
      if (!assignment[0]) return { ok: false, reason: 'not-found' }
      const writtenAt = this.clock()
      await tx`INSERT INTO farm.printer_profiles (assignment_id, farm_id, model, nozzle_diameter_mm, bed_size_x_mm, bed_size_y_mm, bed_size_z_mm, max_hotend_temperature_celsius, max_bed_temperature_celsius, kinematics, compatible_models, notes, updated_by, updated_at) VALUES (${input.assignmentId}::uuid, ${input.farmId}::uuid, ${p.model}, ${p.nozzleDiameterMm}, ${p.bedSizeXMm}, ${p.bedSizeYMm}, ${p.bedSizeZMm}, ${p.maxHotendTemperatureCelsius}, ${p.maxBedTemperatureCelsius}, ${p.kinematics}, ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(p.compatibleModels)}::jsonb)), ${p.notes}, ${accountId}, ${writtenAt}) ON CONFLICT (assignment_id) DO UPDATE SET model = EXCLUDED.model, nozzle_diameter_mm = EXCLUDED.nozzle_diameter_mm, bed_size_x_mm = EXCLUDED.bed_size_x_mm, bed_size_y_mm = EXCLUDED.bed_size_y_mm, bed_size_z_mm = EXCLUDED.bed_size_z_mm, max_hotend_temperature_celsius = EXCLUDED.max_hotend_temperature_celsius, max_bed_temperature_celsius = EXCLUDED.max_bed_temperature_celsius, kinematics = EXCLUDED.kinematics, compatible_models = EXCLUDED.compatible_models, notes = EXCLUDED.notes, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`
      const rows = await fetchRows(
        tx,
        input.farmId,
        input.assignmentId,
        null,
        1,
      )
      if (!rows[0]) return { ok: false, reason: 'not-found' }
      return { ok: true, profile: toView(rows[0], true), canManage: true }
    })
  }
}
