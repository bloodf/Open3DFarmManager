// Issue #222: a member of farm A calls every farm-scoped route of farm B over
// HTTP and is refused exactly as for a farm that does not exist. The real route
// files run behind a loopback server on an ephemeral port; the stores are an
// in-memory model with the membership rules of the PostgreSQL stores. The same
// scenario runs against PostgreSQL in `npm run test:postgres`
// (scripts/test-postgres-cross-farm-http.ts). No service, port or file is needed.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assertCrossFarmDenied,
  serveRoutes,
  testCookieConfig,
  type Backend,
  type FarmIds,
  type Scenario,
} from '../helpers/cross-farm-http.ts'
import type {
  AssignableRole,
  FarmInvite,
  MemberRole,
} from '../../apps/farm/server/services/members.ts'

const origin = 'https://farm.example.invalid'
// Every expiry in this file derives from this single clock reading.
const now = Date.now()
const HOUR = 3_600_000
const uuid = (prefix: string, n: number) =>
  `${prefix}${n}000000-0000-4000-8000-000000000000`.slice(0, 36)

function farmIds(n: number): FarmIds {
  return {
    farmId: uuid('f', n),
    agentId: uuid('a', n),
    assignmentId: uuid('b', n),
    printerKey: `printer-key-farm-${n}`,
    inviteId: uuid('c', n),
    memberId: `member_of_farm_${n}`,
  }
}
const farms = [farmIds(1), farmIds(2)] as const
const unknown = farmIds(9)
const accounts = ['account_zero', 'account_one'] as const
const sessions = ['session_zero', 'session_one'] as const

interface Membership {
  farmId: string
  accountId: string
  role: MemberRole
  revokedAt: number | null
}
interface Assignment {
  id: string
  farmId: string
  agentId: string
  printerKey: string
  status: 'active' | 'revoked'
}
interface Invite {
  id: string
  farmId: string
  role: AssignableRole
  expiresAt: number
  revoked: boolean
}

/** Mirrors the membership rules of the PostgreSQL stores. */
class MemoryFarms {
  readonly memberships: Membership[] = []
  readonly assignments: Assignment[] = []
  readonly invites: Invite[] = []
  readonly connectors: Array<{
    farmId: string
    agentId: string
    status: string
  }> = []
  readonly jobs: Array<{ farmId: string; printerKey: string }> = []
  readonly sessionAccounts = new Map<string, string>()

  constructor() {
    farms.forEach((farm, index) => {
      const owner = accounts[index]!
      this.sessionAccounts.set(sessions[index]!, owner)
      this.memberships.push(
        {
          farmId: farm.farmId,
          accountId: owner,
          role: 'owner',
          revokedAt: null,
        },
        {
          farmId: farm.farmId,
          accountId: farm.memberId,
          role: 'viewer',
          revokedAt: null,
        },
      )
      this.assignments.push({
        id: farm.assignmentId,
        farmId: farm.farmId,
        agentId: farm.agentId,
        printerKey: farm.printerKey,
        status: 'active',
      })
      this.invites.push({
        id: farm.inviteId,
        farmId: farm.farmId,
        role: 'viewer',
        expiresAt: now + 72 * HOUR,
        revoked: false,
      })
      this.connectors.push({
        farmId: farm.farmId,
        agentId: farm.agentId,
        status: 'approved',
      })
      this.jobs.push({ farmId: farm.farmId, printerKey: farm.printerKey })
    })
  }
  accountOf(sessionRecordId: string) {
    return this.sessionAccounts.get(sessionRecordId) ?? null
  }
  role(accountId: string, farmId: string): MemberRole | null {
    return (
      this.memberships.find(
        (m) =>
          m.farmId === farmId &&
          m.accountId === accountId &&
          m.revokedAt === null,
      )?.role ?? null
    )
  }
  isOwner(accountId: string, farmId: string) {
    return this.role(accountId, farmId) === 'owner'
  }
  canManage(accountId: string, farmId: string) {
    const role = this.role(accountId, farmId)
    return role === 'owner' || role === 'admin'
  }
  /** Read access: unauthorized without a live session, forbidden without membership. */
  read(sessionRecordId: string, farmId: string) {
    const accountId = this.accountOf(sessionRecordId)
    if (!accountId)
      return { ok: false as const, reason: 'unauthorized' as const }
    if (!this.role(accountId, farmId))
      return { ok: false as const, reason: 'forbidden' as const }
    return { ok: true as const, accountId }
  }
  snapshot() {
    return JSON.parse(
      JSON.stringify({
        memberships: this.memberships,
        assignments: this.assignments,
        invites: this.invites,
        connectors: this.connectors,
      }),
    ) as unknown
  }
}

function backend(db: MemoryFarms): Backend {
  const auth = {
    origin,
    cookie: testCookieConfig(
      'independent-synthetic-cross-farm-secret-123456789',
    ),
    idleTimeoutMs: 60_000,
    lifetimeMs: 3_600_000,
    sessions: {
      async authorizeAndTouch(id: string) {
        const accountId = db.accountOf(id)
        return accountId
          ? { ok: true as const, accountId, touchAt: now }
          : { ok: false as const, reason: 'missing' as const }
      },
      async revokeSession() {},
      async revokeAccountSessions() {},
    },
    credentials: {
      async consumeLimit() {
        return true
      },
      async find() {
        return null
      },
      async issue() {
        return null
      },
    },
    registration: {
      async bootstrap() {
        return false
      },
      async register() {
        return false
      },
      async createInvite(
        accountId: string,
        farmId: string,
        role: AssignableRole,
      ) {
        if (!db.isOwner(accountId, farmId)) return null
        db.invites.push({
          id: 'created-' + db.invites.length,
          farmId,
          role,
          expiresAt: now + 72 * HOUR,
          revoked: false,
        })
        return new Date(now + 72 * HOUR)
      },
    },
    members: {
      async listMembers(actor: string, farmId: string) {
        if (!db.isOwner(actor, farmId)) return null
        return db.memberships
          .filter((m) => m.farmId === farmId && m.revokedAt === null)
          .map((m) => ({
            accountId: m.accountId,
            username: m.accountId,
            role: m.role,
          }))
      },
      async changeRole(
        actor: string,
        farmId: string,
        accountId: string,
        role: AssignableRole,
      ) {
        const member = db.memberships.find(
          (m) =>
            m.farmId === farmId && m.accountId === accountId && !m.revokedAt,
        )
        if (!db.isOwner(actor, farmId) || !member) return 'not-found' as const
        member.role = role
        return 'ok' as const
      },
      async removeMember(
        actor: string,
        farmId: string,
        accountId: string,
        at: number,
      ) {
        const member = db.memberships.find(
          (m) =>
            m.farmId === farmId && m.accountId === accountId && !m.revokedAt,
        )
        if (!db.isOwner(actor, farmId) || !member) return 'not-found' as const
        member.revokedAt = at
        return 'ok' as const
      },
      async listInvites(
        actor: string,
        farmId: string,
      ): Promise<FarmInvite[] | null> {
        if (!db.isOwner(actor, farmId)) return null
        return db.invites
          .filter((i) => i.farmId === farmId)
          .map((i) => ({
            id: i.id,
            role: i.role,
            createdAt: new Date(now).toISOString(),
            expiresAt: new Date(i.expiresAt).toISOString(),
            status: i.revoked ? ('revoked' as const) : ('pending' as const),
          }))
      },
      async revokeInvite(actor: string, farmId: string, id: string) {
        const invite = db.invites.find(
          (i) => i.id === id && i.farmId === farmId,
        )
        if (!db.isOwner(actor, farmId) || !invite) return 'not-found' as const
        invite.revoked = true
        return 'ok' as const
      },
    },
  } satisfies Backend['auth']
  return {
    auth,
    connectorInventory: {
      async listConnectors(input) {
        const access = db.read(input.sessionRecordId, input.farmId)
        if (!access.ok) return access
        return {
          ok: true,
          connectors: db.connectors
            .filter((c) => c.farmId === input.farmId)
            .map((c) => ({
              agentId: c.agentId,
              fingerprint: 'SHA256:' + 'A'.repeat(43),
              status: c.status as 'approved',
            })),
          nextAfter: null,
        }
      },
    },
    printers: {
      inventory: {
        async list(input) {
          const access = db.read(input.sessionRecordId, input.farmId)
          if (!access.ok) return access
          return {
            ok: true,
            printers: db.assignments
              .filter((a) => a.farmId === input.farmId)
              .map((a) => ({
                assignmentId: a.id,
                agentId: a.agentId,
                printerKey: a.printerKey,
                status: a.status,
                connectorStatus: 'approved' as const,
              })),
            nextAfter: null,
            canManage: db.canManage(access.accountId, input.farmId),
          }
        },
      },
      ownership: {
        async register(input) {
          const accountId = db.accountOf(input.sessionRecordId)
          if (!accountId || !db.canManage(accountId, input.farmId))
            return { ok: false, reason: 'denied' }
          db.assignments.push({
            id: 'assigned-' + db.assignments.length,
            farmId: input.farmId,
            agentId: input.agentId,
            printerKey: input.printerKey,
            status: 'active',
          })
          return { ok: true, assignmentId: 'assigned', status: 'active' }
        },
        async revoke(input) {
          const accountId = db.accountOf(input.sessionRecordId)
          const found = db.assignments.find(
            (a) =>
              a.id === input.expectedAssignmentId && a.farmId === input.farmId,
          )
          if (!accountId || !db.canManage(accountId, input.farmId) || !found)
            return { ok: false, reason: 'denied' }
          found.status = 'revoked'
          return { ok: true, assignmentId: found.id, status: 'revoked' }
        },
      },
    },
    revocation: {
      async revoke(input) {
        const accountId = db.accountOf(input.sessionRecordId)
        const found = db.connectors.find(
          (c) => c.agentId === input.agentId && c.farmId === input.farmId,
        )
        if (!accountId || !db.canManage(accountId, input.farmId) || !found)
          return { ok: false, reason: 'denied' }
        found.status = 'revoked'
        return {
          ok: true,
          status: 'revoked',
          credential: null,
          revokedAt: now,
        } as never
      },
    },
    jobHistory: {
      async list(input) {
        const access = db.read(input.sessionRecordId, input.farmId)
        if (!access.ok) return access
        return {
          ok: true,
          jobs: db.jobs
            .filter((j) => j.farmId === input.farmId)
            .map((j, index) => ({
              id: 'job-' + index,
              printerKey: j.printerKey,
              outcome: 'completed' as const,
              filename: 'part.gcode',
              printDurationSeconds: 60,
              totalDurationSeconds: 70,
              endedAt: now,
            })),
          nextBefore: null,
        }
      },
    },
    printerStates: {
      async list(input) {
        const access = db.read(input.sessionRecordId, input.farmId)
        if (!access.ok) return access
        return {
          ok: true,
          states: db.assignments
            .filter((a) => a.farmId === input.farmId)
            .map((a) => ({
              assignmentId: a.id,
              printerKey: a.printerKey,
              state: 'idle',
              progress: null,
              toolTemperatureCelsius: null,
              bedTemperatureCelsius: null,
              observedAt: now,
            })),
        } as never
      },
    },
    resetLinks: {
      async issue() {
        return false
      },
      async consume() {
        return false
      },
      async issueForMember(actor, farmId, accountId) {
        const member = db.memberships.find(
          (m) =>
            m.farmId === farmId && m.accountId === accountId && !m.revokedAt,
        )
        if (!db.isOwner(actor, farmId) || !member) return null
        return { username: accountId, expiresAt: new Date(now + HOUR) }
      },
    },
  }
}

test('a member of one farm is refused on every route of another farm exactly as for an unknown farm', async () => {
  const db = new MemoryFarms()
  const scenario: Scenario = {
    backend: backend(db),
    sessions,
    farms,
    unknown,
    snapshot: async () => db.snapshot(),
  }
  const server = await serveRoutes(scenario.backend)
  try {
    const { checks } = await assertCrossFarmDenied(scenario, server)
    // Fourteen routes, two directions.
    assert.equal(checks.length, 28)
  } finally {
    await server.close()
  }
})

test('the denial is not a broken fixture: the owner of a farm still reads and writes it', async () => {
  const db = new MemoryFarms()
  const server = await serveRoutes(backend(db))
  try {
    const own = farms[0]
    const created = await server.request(
      sessions[0],
      'POST',
      `/api/farms/${own.farmId}/invites`,
      { role: 'viewer' },
    )
    assert.equal(created.status, 200)
    assert.equal(db.invites.filter((i) => i.farmId === own.farmId).length, 2)
    const revoked = await server.request(
      sessions[0],
      'POST',
      `/api/farms/${own.farmId}/invites/${own.inviteId}/revoke`,
    )
    assert.equal(revoked.status, 200)
    assert.equal(db.invites.find((i) => i.id === own.inviteId)?.revoked, true)
  } finally {
    await server.close()
  }
})

test('a request without a session is refused before any farm is consulted', async () => {
  const db = new MemoryFarms()
  const server = await serveRoutes(backend(db))
  try {
    const response = await server.request(
      'session_nobody',
      'GET',
      `/api/farms/${farms[0].farmId}/printers`,
    )
    assert.equal(response.status, 401)
  } finally {
    await server.close()
  }
})
