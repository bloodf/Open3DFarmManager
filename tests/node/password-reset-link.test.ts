// Owner-issued one-time password reset links (issue #219). No network, database or
// server: the services run against an in-memory store mirroring PostgresPasswordReset.
import assert from 'node:assert/strict'
import test from 'node:test'
import { MembersError } from '../../apps/farm/server/services/members.ts'
import {
  issueResetLink,
  RESET_LINK_TTL_MS,
  type ResetLinkDeps,
  type ResetLinkStore,
} from '../../apps/farm/server/services/password-reset-links.ts'
import {
  completePasswordReset,
  resetTokenDigest,
  type PasswordResetStore,
} from '../../apps/farm/server/services/password-reset.ts'
import { MemorySessionRepository } from '../helpers/memory-session-repository.ts'

const origin = 'https://farm.example.invalid'
const farmId = '11111111-1111-4111-8111-111111111111'
const otherFarm = '22222222-2222-4222-8222-222222222222'
const HOUR = 3_600_000
const hash = async (password: string) => 'hash:' + password

interface Account {
  id: string
  username: string
  passwordHash: string
  credentialVersion: number
  disabled: boolean
}
interface Membership {
  farmId: string
  accountId: string
  role: 'owner' | 'admin' | 'operator' | 'viewer'
  revoked: boolean
}
interface Token {
  digest: string
  credentialVersion: number
  expiresAt: number
}

/** Mirrors PostgresPasswordReset: owner check, one digest per account, expiry, single use. */
class MemoryReset implements ResetLinkStore, PasswordResetStore {
  readonly tokens = new Map<string, Token>()
  readonly accounts: Account[]
  readonly memberships: Membership[]
  private readonly sessions: MemorySessionRepository
  /** Advanced only by tests, from the fixture's single clock reading. */
  clock: number
  constructor(
    accounts: Account[],
    memberships: Membership[],
    sessions: MemorySessionRepository,
    now: number,
  ) {
    this.accounts = accounts
    this.memberships = memberships
    this.sessions = sessions
    this.clock = now
  }
  private active(id: string) {
    return this.accounts.find((a) => a.id === id && !a.disabled)
  }
  private member(farm: string, id: string) {
    return this.memberships.find(
      (m) =>
        m.farmId === farm &&
        m.accountId === id &&
        !m.revoked &&
        this.active(id),
    )
  }
  async issueForMember(
    actor: string,
    farm: string,
    accountId: string,
    digest: string,
  ) {
    if (this.member(farm, actor)?.role !== 'owner') return null
    const target = this.member(farm, accountId) && this.active(accountId)
    if (!target) return null
    const expiresAt = this.clock + RESET_LINK_TTL_MS
    this.tokens.set(target.id, {
      digest,
      credentialVersion: target.credentialVersion,
      expiresAt,
    })
    return { username: target.username, expiresAt: new Date(expiresAt) }
  }
  async issue(): Promise<boolean> {
    throw new Error('Self-service issuance is not used by owner links')
  }
  async consume(username: string, digest: string, passwordHash: string) {
    const account = this.accounts.find(
      (a) => a.username === username && !a.disabled,
    )
    if (!account) return false
    const token = this.tokens.get(account.id)
    if (
      !token ||
      token.digest !== digest ||
      token.credentialVersion !== account.credentialVersion ||
      token.expiresAt <= this.clock
    )
      return false
    this.tokens.delete(account.id)
    account.passwordHash = passwordHash
    account.credentialVersion++
    // PostgreSQL bumps session_version, ending every session of the account.
    await this.sessions.revokeAccountSessions(account.id)
    return true
  }
}

const ids = ['owner', 'admin', 'viewer', 'outsider']
function fixture() {
  // Every expiry and session time derives from this single clock reading.
  const now = Date.now()
  const sessions = new MemorySessionRepository(
    ids.map((id) => ({ id, sessionVersion: 0, disabled: false })),
    ids.flatMap((id) =>
      [1, 2].map((n) => ({
        id: `${id}_session_${n}`,
        accountId: id,
        accountVersion: 0,
        createdAt: now,
        lastSeenAt: now,
        absoluteExpiresAt: now + HOUR,
        revokedAt: null,
      })),
    ),
  )
  const store = new MemoryReset(
    ids.map((id) => ({
      id,
      username: id + '_user',
      passwordHash: 'hash:original',
      credentialVersion: 0,
      disabled: false,
    })),
    [
      { farmId, accountId: 'owner', role: 'owner', revoked: false },
      { farmId, accountId: 'admin', role: 'admin', revoked: false },
      { farmId, accountId: 'viewer', role: 'viewer', revoked: false },
      {
        farmId: otherFarm,
        accountId: 'outsider',
        role: 'owner',
        revoked: false,
      },
    ],
    sessions,
    now,
  )
  const limits: string[] = []
  const deps = (session: string | null): ResetLinkDeps => ({
    origin,
    store,
    async authenticate() {
      if (session === null) throw new MembersError(401, 'unauthorized')
      const decision = await sessions.authorizeAndTouch(session, store.clock, {
        idleTimeoutMs: HOUR,
      })
      if (!decision.ok) throw new MembersError(401, 'unauthorized')
      return { accountId: decision.accountId }
    },
    async limit(key) {
      limits.push(key)
    },
  })
  return { now, store, sessions, deps, limits }
}
function post(from: string | null = origin) {
  return new Request(origin + '/x', {
    method: 'POST',
    headers: from === null ? {} : { origin: from },
  })
}
function linkParts(url: string) {
  const parsed = new URL(url)
  const fragment = new URLSearchParams(parsed.hash.slice(1))
  return {
    parsed,
    username: fragment.get('usuario') ?? '',
    token: fragment.get('codigo') ?? '',
  }
}
const status = (code: number) => (error: unknown) =>
  error instanceof MembersError && error.status === code
const complete = (
  store: PasswordResetStore,
  username: string,
  token: string,
  password = 'new-password-long',
) => completePasswordReset({ username, token, password }, store, hash)

test('owner generates a link once; member sets a new password with it', async () => {
  const f = fixture()
  const issued = await issueResetLink(
    f.deps('owner_session_1'),
    post(),
    farmId,
    'viewer',
  )
  const { parsed, username, token } = linkParts(issued.url)
  assert.equal(parsed.origin + parsed.pathname, origin + '/redefinir-senha')
  assert.equal(parsed.search, '', 'token stays out of the query string')
  assert.equal(username, 'viewer_user')
  assert.equal(issued.username, 'viewer_user')
  assert.equal(
    issued.expiresAt,
    new Date(f.now + RESET_LINK_TTL_MS).toISOString(),
  )
  assert.match(token, /^[A-Za-z0-9_-]{43}$/)
  // Hashed at rest: only the digest is stored, never the token.
  const stored = f.store.tokens.get('viewer')
  assert.equal(stored?.digest, resetTokenDigest(token))
  assert.ok(!JSON.stringify([...f.store.tokens]).includes(token))
  assert.deepEqual(f.limits, ['reset-link:owner'])

  assert.equal(await complete(f.store, username, token), true)
  assert.equal(
    f.store.accounts.find((a) => a.id === 'viewer')?.passwordHash,
    'hash:new-password-long',
  )
})

test('a link is single use', async () => {
  const f = fixture()
  const { url } = await issueResetLink(
    f.deps('owner_session_1'),
    post(),
    farmId,
    'admin',
  )
  const { username, token } = linkParts(url)
  assert.equal(await complete(f.store, username, token), true)
  assert.equal(
    await complete(f.store, username, token, 'another-password'),
    false,
  )
  assert.equal(
    f.store.accounts.find((a) => a.id === 'admin')?.passwordHash,
    'hash:new-password-long',
  )
})

test('a link expires after the short window', async () => {
  const f = fixture()
  const { url } = await issueResetLink(
    f.deps('owner_session_1'),
    post(),
    farmId,
    'admin',
  )
  const { username, token } = linkParts(url)
  f.store.clock = f.now + RESET_LINK_TTL_MS
  assert.equal(await complete(f.store, username, token), false)
  assert.equal(
    f.store.accounts.find((a) => a.id === 'admin')?.passwordHash,
    'hash:original',
  )
})

test('issuing again replaces the earlier link', async () => {
  const f = fixture()
  const first = linkParts(
    (await issueResetLink(f.deps('owner_session_1'), post(), farmId, 'admin'))
      .url,
  )
  const second = linkParts(
    (await issueResetLink(f.deps('owner_session_1'), post(), farmId, 'admin'))
      .url,
  )
  assert.notEqual(first.token, second.token)
  assert.equal(await complete(f.store, first.username, first.token), false)
  assert.equal(await complete(f.store, second.username, second.token), true)
})

test('a link is bound to its account and to a valid new password', async () => {
  const f = fixture()
  const { token } = linkParts(
    (await issueResetLink(f.deps('owner_session_1'), post(), farmId, 'admin'))
      .url,
  )
  assert.equal(await complete(f.store, 'viewer_user', token), false)
  assert.equal(await complete(f.store, 'admin_user', token, 'short'), false)
  assert.equal(await complete(f.store, 'admin_user', token), true)
})

test('every session of the account is revoked after reset', async () => {
  const f = fixture()
  const { username, token } = linkParts(
    (await issueResetLink(f.deps('owner_session_1'), post(), farmId, 'viewer'))
      .url,
  )
  for (const id of ['viewer_session_1', 'viewer_session_2'])
    assert.equal(
      (await f.sessions.authorizeAndTouch(id, f.now, { idleTimeoutMs: HOUR }))
        .ok,
      true,
    )
  assert.equal(await complete(f.store, username, token), true)
  for (const id of ['viewer_session_1', 'viewer_session_2'])
    assert.equal(
      (await f.sessions.authorizeAndTouch(id, f.now, { idleTimeoutMs: HOUR }))
        .ok,
      false,
    )
  // Other accounts keep their sessions.
  assert.equal(
    (
      await f.sessions.authorizeAndTouch('owner_session_2', f.now, {
        idleTimeoutMs: HOUR,
      })
    ).ok,
    true,
  )
})

test('non-owners cannot generate links', async () => {
  const f = fixture()
  for (const session of [
    'admin_session_1',
    'viewer_session_1',
    'outsider_session_1',
  ])
    await assert.rejects(
      issueResetLink(f.deps(session), post(), farmId, 'viewer'),
      status(404),
      session,
    )
  await assert.rejects(
    issueResetLink(f.deps(null), post(), farmId, 'viewer'),
    status(401),
  )
  assert.equal(f.store.tokens.size, 0)
})

test('owners cannot target accounts outside their farm or bad input', async () => {
  const f = fixture()
  const deps = f.deps('owner_session_1')
  await assert.rejects(
    issueResetLink(deps, post(), farmId, 'outsider'),
    status(404),
  )
  await assert.rejects(
    issueResetLink(deps, post(), otherFarm, 'outsider'),
    status(404),
  )
  await assert.rejects(
    issueResetLink(deps, post(), 'not-a-uuid', 'viewer'),
    status(404),
  )
  await assert.rejects(
    issueResetLink(deps, post(), farmId, '../viewer'),
    status(404),
  )
  f.store.memberships.find((m) => m.accountId === 'admin')!.revoked = true
  await assert.rejects(
    issueResetLink(deps, post(), farmId, 'admin'),
    status(404),
  )
  f.store.accounts.find((a) => a.id === 'viewer')!.disabled = true
  await assert.rejects(
    issueResetLink(deps, post(), farmId, 'viewer'),
    status(404),
  )
  assert.equal(f.store.tokens.size, 0)
})

test('foreign or missing origin and a disabled feature are refused', async () => {
  const f = fixture()
  await assert.rejects(
    issueResetLink(
      f.deps('owner_session_1'),
      post('https://evil.example.invalid'),
      farmId,
      'viewer',
    ),
    status(403),
  )
  await assert.rejects(
    issueResetLink(f.deps('owner_session_1'), post(null), farmId, 'viewer'),
    status(403),
  )
  await assert.rejects(
    issueResetLink(
      { ...f.deps('owner_session_1'), store: undefined },
      post(),
      farmId,
      'viewer',
    ),
    status(404),
  )
  assert.equal(f.store.tokens.size, 0)
})
