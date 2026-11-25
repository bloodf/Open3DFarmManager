// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto'
import type { Sql, TransactionSql } from 'postgres'
import {
  evaluateSession,
  type AccountSessionState,
  type SessionPolicy,
  type SessionRecord,
} from '../utils/auth/session-contract.ts'
import type { SpoolSlotKind } from './spool-features-types.ts'

export interface SpoolMoveAuthority {
  farmId: string
  sessionRecordId: string
  policy: SessionPolicy
}

export interface SpoolSlotRef {
  printerId: string
  slotKind: SpoolSlotKind
  slotIndex: number
}

export type SpoolMoveTarget =
  | { to: 'location'; location: string | null }
  | ({ to: 'slot' } & SpoolSlotRef)
  | { to: 'farm'; farmId: string; location?: string | null | undefined }

export interface SpoolMoveResult {
  moved: boolean
  /** Stable across farms; null while the spool has never moved. */
  identity: string | null
  farmId: string
  spoolId: number
}

export interface SpoolMoveValue {
  location?: string | null
  slots?: SpoolSlotRef[]
}

export interface SpoolMoveSide {
  /** Null when the caller is not a member of that farm. */
  farmId: string | null
  spoolId: number | null
}

export interface SpoolMoveEntry {
  id: string
  kind: 'location' | 'slot' | 'farm'
  movedAt: number
  movedBy: string
  source: SpoolMoveSide
  destination: SpoolMoveSide
  /** Null for the side that belongs to another farm. */
  from: SpoolMoveValue | null
  to: SpoolMoveValue | null
}

export interface SpoolMoveHistory {
  identity: string | null
  moves: SpoolMoveEntry[]
}

export interface SpoolMoves {
  move(
    authority: SpoolMoveAuthority,
    spoolId: number,
    target: SpoolMoveTarget,
  ): Promise<SpoolMoveResult>
  history(
    authority: SpoolMoveAuthority,
    spoolId: number,
  ): Promise<SpoolMoveHistory>
}

/**
 * 400 invalid, 401 no session, 403 read-only role, 404 outside the caller's
 * farms (indistinguishable from missing), 409 the spool cannot move from here.
 */
export class SpoolMoveError extends Error {
  readonly status: number
  constructor(status: number) {
    super('Spool move request rejected')
    this.status = status
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const roles = ['owner', 'admin', 'operator', 'viewer']
const positive = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 1

function location(value: string | null | undefined): string | null {
  const text = value?.trim() ?? ''
  if (text.length > 256 || text.includes('\0')) throw new SpoolMoveError(400)
  return text || null
}

interface SpoolRow {
  location: string | null
  archived: boolean
  filamentId: number
}

interface Journal {
  identity: string
  kind: SpoolMoveEntry['kind']
  source: { farmId: string; spoolId: number }
  destination: { farmId: string; spoolId: number }
  from: SpoolMoveValue
  to: SpoolMoveValue
  actor: string
  now: number
}

interface Session {
  accountId: string
  now: number
}

/**
 * Moves a spool and journals the move in one transaction. Needs a login that is
 * a member of farm_spool_library and farm_spool_features. Every statement names
 * a farm the session's account was just shown to belong to.
 */
export class PostgresSpoolMoves implements SpoolMoves {
  constructor(
    private readonly sql: Sql,
    private readonly clock: () => number = Date.now,
  ) {}

  private async session<T>(
    authority: SpoolMoveAuthority,
    spoolId: number,
    work: (tx: TransactionSql, session: Session) => Promise<T>,
  ): Promise<T> {
    if (
      !uuid.test(authority.farmId) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(authority.sessionRecordId) ||
      !positive(spoolId)
    )
      throw new SpoolMoveError(400)
    const result = await this.sql.begin(async (tx) => {
      await tx`SET LOCAL statement_timeout = '2000ms'`
      await tx`SET LOCAL lock_timeout = '1000ms'`
      const accounts = await tx<
        AccountSessionState[]
      >`SELECT id, session_version::float8 AS "sessionVersion", disabled FROM farm.session_accounts WHERE id=(SELECT account_id FROM farm.account_sessions WHERE id=${authority.sessionRecordId}) FOR SHARE`
      const sessions = await tx<
        SessionRecord[]
      >`SELECT id, account_id AS "accountId", account_version::float8 AS "accountVersion", created_at::float8 AS "createdAt", last_seen_at::float8 AS "lastSeenAt", absolute_expires_at::float8 AS "absoluteExpiresAt", revoked_at::float8 AS "revokedAt" FROM farm.account_sessions WHERE id=${authority.sessionRecordId} FOR UPDATE`
      const now = this.clock()
      const check = () =>
        evaluateSession(
          authority.sessionRecordId,
          sessions[0] ?? null,
          accounts[0] ?? null,
          this.clock(),
          authority.policy,
        )
      const decision = check()
      if (!decision.ok) throw new SpoolMoveError(401)
      const value = await work(tx, { accountId: decision.accountId, now })
      const last = check()
      if (!last.ok) throw new SpoolMoveError(401)
      await tx`UPDATE farm.account_sessions SET last_seen_at=${last.touchAt} WHERE id=${authority.sessionRecordId}`
      return { value }
    })
    return result.value as T
  }

  private async role(
    tx: TransactionSql,
    farmId: string,
    accountId: string,
  ): Promise<string | null> {
    const rows =
      await tx`SELECT role, revoked_at FROM farm.memberships WHERE farm_id=${farmId}::uuid AND account_id=${accountId} FOR SHARE`
    const role: unknown = rows[0]?.revoked_at === null ? rows[0]?.role : null
    return roles.includes(role as string) ? (role as string) : null
  }

  async move(
    authority: SpoolMoveAuthority,
    spoolId: number,
    target: SpoolMoveTarget,
  ): Promise<SpoolMoveResult> {
    const source = authority.farmId
    if (target.to === 'farm') {
      if (!uuid.test(target.farmId) || target.farmId === source)
        throw new SpoolMoveError(400)
    } else if (
      target.to === 'slot' &&
      (!uuid.test(target.printerId) ||
        !['printer', 'ams', 'toolhead'].includes(target.slotKind) ||
        !Number.isInteger(target.slotIndex) ||
        target.slotIndex < 0 ||
        target.slotIndex > 1024)
    )
      throw new SpoolMoveError(400)

    return this.session(authority, spoolId, async (tx, session) => {
      const farms = (
        target.to === 'farm' ? [source, target.farmId] : [source]
      ).sort()
      const held = new Map<string, string | null>()
      for (const farm of farms)
        held.set(farm, await this.role(tx, farm, session.accountId))
      // Membership first: a role is never reported for a farm out of scope.
      if (farms.some((farm) => !held.get(farm))) throw new SpoolMoveError(404)
      if (farms.some((farm) => held.get(farm) === 'viewer'))
        throw new SpoolMoveError(403)
      // The same per-farm lock slot assignment takes, in a stable order.
      for (const farm of farms)
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${farm},0))`

      const spool = await this.spool(tx, source, spoolId)
      if (!spool) throw new SpoolMoveError(404)
      // An archived row is retired, or already continues in another farm.
      if (spool.archived) throw new SpoolMoveError(409)
      const context = { tx, source, spoolId, spool, session }
      if (target.to === 'location')
        return this.toLocation(context, location(target.location))
      if (target.to === 'slot') return this.toSlot(context, target)
      return this.toFarm(context, target.farmId, location(target.location))
    })
  }

  private async spool(
    tx: TransactionSql,
    farmId: string,
    spoolId: number,
  ): Promise<SpoolRow | null> {
    const rows = await tx<
      SpoolRow[]
    >`SELECT location, archived, filament_id::float8 AS "filamentId" FROM farm.spools WHERE farm_id=${farmId}::uuid AND id=${spoolId} FOR UPDATE`
    return rows[0] ?? null
  }

  private async identityOf(
    tx: TransactionSql,
    farmId: string,
    spoolId: number,
  ): Promise<string | null> {
    const rows = await tx<
      { identity: string }[]
    >`SELECT identity::text AS identity FROM farm.spool_identities WHERE farm_id=${farmId}::uuid AND spool_id=${spoolId}`
    return rows[0]?.identity ?? null
  }

  private async ensureIdentity(
    tx: TransactionSql,
    farmId: string,
    spoolId: number,
  ): Promise<string> {
    const current = await this.identityOf(tx, farmId, spoolId)
    if (current) return current
    const identity = randomUUID()
    await tx`INSERT INTO farm.spool_identities (farm_id, spool_id, identity) VALUES (${farmId}::uuid, ${spoolId}, ${identity}::uuid)`
    return identity
  }

  private async journal(tx: TransactionSql, entry: Journal): Promise<void> {
    await tx`INSERT INTO farm.spool_moves (id, identity, kind, source_farm_id, source_spool_id, destination_farm_id, destination_spool_id, from_value, to_value, moved_by, moved_at)
      VALUES (${randomUUID()}::uuid, ${entry.identity}::uuid, ${entry.kind}, ${entry.source.farmId}::uuid, ${entry.source.spoolId}, ${entry.destination.farmId}::uuid, ${entry.destination.spoolId}, ${tx.json(entry.from as never)}, ${tx.json(entry.to as never)}, ${entry.actor}, ${entry.now})`
  }

  private async bindings(
    tx: TransactionSql,
    farmId: string,
    spoolId: number,
  ): Promise<SpoolSlotRef[]> {
    const rows = await tx<
      SpoolSlotRef[]
    >`SELECT printer_id::text AS "printerId", slot_kind AS "slotKind", slot_index AS "slotIndex" FROM farm.spool_slot_assignments WHERE farm_id=${farmId}::uuid AND spool_id=${spoolId} AND unassigned_at IS NULL ORDER BY printer_id, slot_kind, slot_index`
    return rows.map((row) => ({ ...row }))
  }

  /** Closes the open bindings; the rows stay as history. */
  private async release(
    tx: TransactionSql,
    farmId: string,
    spoolId: number,
    now: number,
  ): Promise<void> {
    await tx`UPDATE farm.spool_slot_assignments SET unassigned_at=GREATEST(assigned_at, ${now}) WHERE farm_id=${farmId}::uuid AND spool_id=${spoolId} AND unassigned_at IS NULL`
  }

  private async toLocation(
    context: Context,
    next: string | null,
  ): Promise<SpoolMoveResult> {
    const { tx, source, spoolId, spool, session } = context
    const here = { farmId: source, spoolId }
    if (spool.location === next)
      return {
        moved: false,
        identity: await this.identityOf(tx, source, spoolId),
        ...here,
      }
    await tx`UPDATE farm.spools SET location=${next} WHERE farm_id=${source}::uuid AND id=${spoolId}`
    const identity = await this.ensureIdentity(tx, source, spoolId)
    await this.journal(tx, {
      identity,
      kind: 'location',
      source: here,
      destination: here,
      from: { location: spool.location },
      to: { location: next },
      actor: session.accountId,
      now: session.now,
    })
    return { moved: true, identity, ...here }
  }

  private async toSlot(
    context: Context,
    slot: SpoolSlotRef,
  ): Promise<SpoolMoveResult> {
    const { tx, source, spoolId, session } = context
    const printer =
      await tx`SELECT 1 FROM farm.printer_assignments WHERE farm_id=${source}::uuid AND id=${slot.printerId}::uuid AND revoked_at IS NULL`
    if (!printer[0]) throw new SpoolMoveError(404)
    const here = { farmId: source, spoolId }
    const next: SpoolSlotRef = {
      printerId: slot.printerId,
      slotKind: slot.slotKind,
      slotIndex: slot.slotIndex,
    }
    const before = await this.bindings(tx, source, spoolId)
    if (
      before.length === 1 &&
      before[0]!.printerId === next.printerId &&
      before[0]!.slotKind === next.slotKind &&
      before[0]!.slotIndex === next.slotIndex
    )
      return {
        moved: false,
        identity: await this.identityOf(tx, source, spoolId),
        ...here,
      }
    const occupant = await tx<
      { spoolId: number }[]
    >`SELECT spool_id::float8 AS "spoolId" FROM farm.spool_slot_assignments WHERE farm_id=${source}::uuid AND printer_id=${next.printerId}::uuid AND slot_kind=${next.slotKind} AND slot_index=${next.slotIndex} AND unassigned_at IS NULL AND spool_id<>${spoolId}`
    if (occupant[0]) {
      // The spool pushed out of the slot moved too, so it is journaled too.
      const other = { farmId: source, spoolId: occupant[0].spoolId }
      await tx`UPDATE farm.spool_slot_assignments SET unassigned_at=GREATEST(assigned_at, ${session.now}) WHERE farm_id=${source}::uuid AND printer_id=${next.printerId}::uuid AND slot_kind=${next.slotKind} AND slot_index=${next.slotIndex} AND unassigned_at IS NULL`
      await this.journal(tx, {
        identity: await this.ensureIdentity(tx, source, other.spoolId),
        kind: 'slot',
        source: other,
        destination: other,
        from: { slots: [next] },
        to: { slots: [] },
        actor: session.accountId,
        now: session.now,
      })
    }
    await this.release(tx, source, spoolId, session.now)
    await tx`INSERT INTO farm.spool_slot_assignments (farm_id, id, spool_id, printer_id, slot_kind, slot_index, assigned_at)
      VALUES (${source}::uuid, ${randomUUID()}::uuid, ${spoolId}, ${next.printerId}::uuid, ${next.slotKind}, ${next.slotIndex}, ${session.now})`
    const identity = await this.ensureIdentity(tx, source, spoolId)
    await this.journal(tx, {
      identity,
      kind: 'slot',
      source: here,
      destination: here,
      from: { slots: before },
      to: { slots: [next] },
      actor: session.accountId,
      now: session.now,
    })
    return { moved: true, identity, ...here }
  }

  private async toFarm(
    context: Context,
    destination: string,
    nextLocation: string | null,
  ): Promise<SpoolMoveResult> {
    const { tx, source, spoolId, spool, session } = context
    const identity = await this.ensureIdentity(tx, source, spoolId)
    // Only the farm that holds the spool may send it on. A source row that was
    // un-archived by hand after it left must not overwrite the current one.
    const last = await tx<
      { farmId: string }[]
    >`SELECT destination_farm_id::text AS "farmId" FROM farm.spool_moves WHERE identity=${identity}::uuid AND kind='farm' ORDER BY seq DESC LIMIT 1`
    if (last[0] && last[0].farmId !== source) throw new SpoolMoveError(409)

    const filamentId = await this.copyFilament(
      tx,
      source,
      destination,
      spool.filamentId,
    )
    const known = await tx<
      { id: number }[]
    >`SELECT spool_id::float8 AS id FROM farm.spool_identities WHERE farm_id=${destination}::uuid AND identity=${identity}::uuid`
    let target = known[0]?.id
    if (target === undefined) {
      target = await this.nextId(tx, destination, 'spool')
      await tx`INSERT INTO farm.spools (farm_id, id, filament_id, initial_weight, spool_weight, used_weight, price, location, lot_nr, comment, archived, extra, registered_at, first_used_at, last_used_at)
        SELECT ${destination}::uuid, ${target}, ${filamentId}, initial_weight, spool_weight, used_weight, price, ${nextLocation}, lot_nr, comment, false, extra, registered_at, first_used_at, last_used_at
        FROM farm.spools WHERE farm_id=${source}::uuid AND id=${spoolId}`
      await tx`INSERT INTO farm.spool_identities (farm_id, spool_id, identity) VALUES (${destination}::uuid, ${target}, ${identity}::uuid)`
    } else {
      // The spool is back: revive its old row, which still owns its history.
      await tx`UPDATE farm.spools d SET filament_id=${filamentId}, initial_weight=s.initial_weight, spool_weight=s.spool_weight, used_weight=s.used_weight, price=s.price, location=${nextLocation}, lot_nr=s.lot_nr, comment=s.comment, archived=false, extra=s.extra, first_used_at=s.first_used_at, last_used_at=s.last_used_at
        FROM farm.spools s WHERE s.farm_id=${source}::uuid AND s.id=${spoolId} AND d.farm_id=${destination}::uuid AND d.id=${target}`
    }
    const slots = await this.bindings(tx, source, spoolId)
    await this.release(tx, source, spoolId, session.now)
    await tx`UPDATE farm.spools SET archived=true WHERE farm_id=${source}::uuid AND id=${spoolId}`
    await this.journal(tx, {
      identity,
      kind: 'farm',
      source: { farmId: source, spoolId },
      destination: { farmId: destination, spoolId: target },
      from: { location: spool.location, slots },
      to: { location: nextLocation },
      actor: session.accountId,
      now: session.now,
    })
    return { moved: true, identity, farmId: destination, spoolId: target }
  }

  private async nextId(
    tx: TransactionSql,
    farmId: string,
    kind: 'vendor' | 'filament' | 'spool',
  ): Promise<number> {
    const rows = await tx<{ id: number }[]>`
      INSERT INTO farm.spool_library_counters (farm_id, kind, last_id)
      VALUES (${farmId}::uuid, ${kind}, 1)
      ON CONFLICT (farm_id, kind) DO UPDATE SET last_id = farm.spool_library_counters.last_id + 1
      RETURNING last_id::float8 AS id`
    return Number(rows[0]?.id)
  }

  /** The destination's identical vendor, or a copy of the source's. */
  private async copyVendor(
    tx: TransactionSql,
    source: string,
    destination: string,
    vendorId: number,
  ): Promise<number> {
    const same = await tx<{ id: number }[]>`
      SELECT d.id::float8 AS id FROM farm.spool_vendors s, farm.spool_vendors d
      WHERE s.farm_id=${source}::uuid AND s.id=${vendorId} AND d.farm_id=${destination}::uuid
        AND ROW(d.name, d.comment, d.empty_spool_weight, d.external_id, d.extra)
          IS NOT DISTINCT FROM ROW(s.name, s.comment, s.empty_spool_weight, s.external_id, s.extra)
      ORDER BY d.id LIMIT 1`
    if (same[0]) return same[0].id
    const id = await this.nextId(tx, destination, 'vendor')
    await tx`INSERT INTO farm.spool_vendors (farm_id, id, name, comment, empty_spool_weight, external_id, extra, registered_at)
      SELECT ${destination}::uuid, ${id}, name, comment, empty_spool_weight, external_id, extra, registered_at
      FROM farm.spool_vendors WHERE farm_id=${source}::uuid AND id=${vendorId}`
    return id
  }

  /** The destination's identical filament, or a copy of the source's. */
  private async copyFilament(
    tx: TransactionSql,
    source: string,
    destination: string,
    filamentId: number,
  ): Promise<number> {
    const rows = await tx<
      { vendorId: number | null }[]
    >`SELECT vendor_id::float8 AS "vendorId" FROM farm.spool_filaments WHERE farm_id=${source}::uuid AND id=${filamentId}`
    const vendor = rows[0]?.vendorId
    const vendorId =
      vendor == null
        ? null
        : await this.copyVendor(tx, source, destination, vendor)
    const same = await tx<{ id: number }[]>`
      SELECT d.id::float8 AS id FROM farm.spool_filaments s, farm.spool_filaments d
      WHERE s.farm_id=${source}::uuid AND s.id=${filamentId} AND d.farm_id=${destination}::uuid
        AND d.vendor_id IS NOT DISTINCT FROM ${vendorId}::bigint
        AND ROW(d.name, d.material, d.color_hex, d.multi_color_hexes, d.multi_color_direction, d.article_number, d.settings_extruder_temp, d.settings_bed_temp, d.density, d.diameter, d.weight, d.spool_weight, d.price, d.comment, d.external_id, d.extra)
          IS NOT DISTINCT FROM ROW(s.name, s.material, s.color_hex, s.multi_color_hexes, s.multi_color_direction, s.article_number, s.settings_extruder_temp, s.settings_bed_temp, s.density, s.diameter, s.weight, s.spool_weight, s.price, s.comment, s.external_id, s.extra)
      ORDER BY d.id LIMIT 1`
    if (same[0]) return same[0].id
    const id = await this.nextId(tx, destination, 'filament')
    await tx`INSERT INTO farm.spool_filaments (farm_id, id, vendor_id, name, material, color_hex, multi_color_hexes, multi_color_direction, article_number, settings_extruder_temp, settings_bed_temp, density, diameter, weight, spool_weight, price, comment, external_id, extra, registered_at)
      SELECT ${destination}::uuid, ${id}, ${vendorId}::bigint, name, material, color_hex, multi_color_hexes, multi_color_direction, article_number, settings_extruder_temp, settings_bed_temp, density, diameter, weight, spool_weight, price, comment, external_id, extra, registered_at
      FROM farm.spool_filaments WHERE farm_id=${source}::uuid AND id=${filamentId}`
    return id
  }

  /** The journal entries that touch this farm's spool. */
  history(
    authority: SpoolMoveAuthority,
    spoolId: number,
  ): Promise<SpoolMoveHistory> {
    const farm = authority.farmId
    return this.session(authority, spoolId, async (tx, session) => {
      if (!(await this.role(tx, farm, session.accountId)))
        throw new SpoolMoveError(404)
      const spool =
        await tx`SELECT 1 FROM farm.spools WHERE farm_id=${farm}::uuid AND id=${spoolId}`
      if (!spool[0]) throw new SpoolMoveError(404)
      const identity = await this.identityOf(tx, farm, spoolId)
      if (!identity) return { identity: null, moves: [] }
      const rows = await tx<
        {
          id: string
          kind: SpoolMoveEntry['kind']
          sourceFarm: string
          sourceSpool: number
          destinationFarm: string
          destinationSpool: number
          from: SpoolMoveValue
          to: SpoolMoveValue
          movedBy: string
          movedAt: number
        }[]
      >`SELECT id::text AS id, kind, source_farm_id::text AS "sourceFarm", source_spool_id::float8 AS "sourceSpool", destination_farm_id::text AS "destinationFarm", destination_spool_id::float8 AS "destinationSpool", from_value AS "from", to_value AS "to", moved_by AS "movedBy", moved_at::float8 AS "movedAt"
        FROM farm.spool_moves WHERE identity=${identity}::uuid AND (source_farm_id=${farm}::uuid OR destination_farm_id=${farm}::uuid) ORDER BY seq DESC LIMIT 200`
      const member = new Map<string, boolean>([[farm, true]])
      const side = async (
        farmId: string,
        id: number,
      ): Promise<SpoolMoveSide> => {
        let visible = member.get(farmId)
        if (visible === undefined) {
          visible = !!(await this.role(tx, farmId, session.accountId))
          member.set(farmId, visible)
        }
        return visible
          ? { farmId, spoolId: id }
          : { farmId: null, spoolId: null }
      }
      const moves: SpoolMoveEntry[] = []
      for (const row of rows)
        moves.push({
          id: row.id,
          kind: row.kind,
          movedAt: row.movedAt,
          movedBy: row.movedBy,
          source: await side(row.sourceFarm, row.sourceSpool),
          destination: await side(row.destinationFarm, row.destinationSpool),
          from: row.sourceFarm === farm ? row.from : null,
          to: row.destinationFarm === farm ? row.to : null,
        })
      return { identity, moves }
    })
  }
}

interface Context {
  tx: TransactionSql
  source: string
  spoolId: number
  spool: SpoolRow
  session: Session
}
