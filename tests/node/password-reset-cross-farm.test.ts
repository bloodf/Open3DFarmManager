// Owner-issued reset links must not reach accounts that also belong to another
// farm (review finding on issue #219). Runs the real PostgresPasswordReset against
// a strict in-memory driver that answers only the statements it recognises, so
// no network, database or server is needed. The PostgreSQL suite
// scripts/test-postgres-password-reset.ts proves the same rules on a real server.
import assert from 'node:assert/strict'
import test from 'node:test'
import type { Sql } from 'postgres'
import { MembersError } from '../../apps/farm/server/services/members.ts'
import {
  issueResetLink,
  type ResetLinkDeps,
} from '../../apps/farm/server/services/password-reset-links.ts'
import { completePasswordReset } from '../../apps/farm/server/services/password-reset.ts'
import { PostgresPasswordReset } from '../../apps/farm/server/storage/postgres-password-reset.ts'

const origin = 'https://farm.example.invalid'
const farmA = '11111111-1111-4111-8111-111111111111'
const farmB = '22222222-2222-4222-8222-222222222222'

interface Membership {
  farm: string
  account: string
  role: string
  revoked: boolean
}
interface Token {
  digest: string
  version: number
  ownerFarm: string | null
}

/** Strict fake of the statements PostgresPasswordReset issues; anything else throws. */
function fakeDatabase() {
  const accounts = new Map(
    ['alice', 'bob', 'carol'].map((id) => [
      id,
      { username: id + '_user', hash: 'hash:original', version: 0 },
    ]),
  )
  const memberships: Membership[] = [
    { farm: farmA, account: 'alice', role: 'owner', revoked: false },
    { farm: farmB, account: 'bob', role: 'owner', revoked: false },
    { farm: farmA, account: 'carol', role: 'viewer', revoked: false },
  ]
  const tokens = new Map<string, Token>()
  const active = (farm: string, account: string) =>
    memberships.find(
      (m) => m.farm === farm && m.account === account && !m.revoked,
    )
  const query = (text: string, v: unknown[]): Record<string, unknown>[] => {
    if (text.startsWith('SET LOCAL')) return []
    if (text.includes("m.role = 'owner'")) {
      const m = active(v[0] as string, v[1] as string)
      return m?.role === 'owner' ? [{ '?column?': 1 }] : []
    }
    if (text.startsWith('SELECT a.id, c.username FROM farm.memberships')) {
      const id = v[1] as string
      return active(v[0] as string, id)
        ? [{ id, username: accounts.get(id)?.username }]
        : []
    }
    if (text.includes('count(*) FILTER')) {
      const [farm, , account] = v as string[]
      const live = memberships.filter(
        (m) => m.account === account && !m.revoked,
      )
      return [
        {
          own: live.filter((m) => m.farm === farm).length,
          other: live.filter((m) => m.farm !== farm).length,
        },
      ]
    }
    if (text.startsWith('SELECT credential_version FROM')) {
      const account = accounts.get(v[0] as string)
      return account ? [{ credential_version: account.version }] : []
    }
    if (text.startsWith('INSERT INTO farm.password_reset_tokens')) {
      tokens.set(v[0] as string, {
        digest: v[1] as string,
        version: v[2] as number,
        ownerFarm: (v[3] as string | undefined) ?? null,
      })
      return [{ expires_at: new Date(Date.now() + 15 * 60_000) }]
    }
    if (text.startsWith('SELECT a.id FROM farm.session_accounts')) {
      const found = [...accounts].find(([, a]) => a.username === v[0])
      return found ? [{ id: found[0] }] : []
    }
    if (text.startsWith('DELETE FROM farm.password_reset_tokens')) {
      const [id, digest, version] = v as [string, string, number]
      const token = tokens.get(id)
      if (!token || token.digest !== digest || token.version !== version)
        return []
      tokens.delete(id)
      return [{ account_id: id, owner_farm_id: token.ownerFarm }]
    }
    if (text.startsWith('UPDATE farm.password_credentials')) {
      const account = accounts.get(v[1] as string)!
      account.hash = v[0] as string
      account.version++
      return []
    }
    if (text.startsWith('UPDATE farm.session_accounts')) return []
    throw new Error('Unexpected statement: ' + text)
  }
  const tx = (strings: TemplateStringsArray, ...values: unknown[]) =>
    Promise.resolve(
      query(strings.join('$').replace(/\s+/g, ' ').trim(), values),
    )
  const sql = {
    begin: async <T>(fn: (t: typeof tx) => Promise<T>) => await fn(tx),
  } as unknown as Sql
  return {
    store: new PostgresPasswordReset(sql),
    accounts,
    memberships,
    tokens,
  }
}

function deps(store: PostgresPasswordReset, accountId: string): ResetLinkDeps {
  return {
    origin,
    store,
    async authenticate() {
      return { accountId }
    },
    async limit() {},
  }
}
const post = () =>
  new Request(origin + '/x', { method: 'POST', headers: { origin } })
const link = (url: string) => {
  const fragment = new URLSearchParams(new URL(url).hash.slice(1))
  return {
    username: fragment.get('usuario') ?? '',
    token: fragment.get('codigo') ?? '',
  }
}
const conflict = (error: unknown) =>
  error instanceof MembersError && error.status === 409
const redeem = (store: PostgresPasswordReset, url: string) =>
  completePasswordReset(
    { ...link(url), password: 'attacker-password-long' },
    store,
    async (password) => 'hash:' + password,
  )

test('an owner cannot reset the account of another farm owner who joined their farm', async () => {
  const db = fakeDatabase()
  // Reviewer repro: bob (owner of farm B) joins alice's farm A as viewer.
  db.memberships.push({
    farm: farmA,
    account: 'bob',
    role: 'viewer',
    revoked: false,
  })
  await assert.rejects(
    issueResetLink(deps(db.store, 'alice'), post(), farmA, 'bob'),
    conflict,
  )
  assert.equal(db.tokens.size, 0)
  assert.equal(db.accounts.get('bob')?.hash, 'hash:original')
})

test('an owner cannot issue a reset link for their own account', async () => {
  const db = fakeDatabase()
  await assert.rejects(
    issueResetLink(deps(db.store, 'alice'), post(), farmA, 'alice'),
    conflict,
  )
  assert.equal(db.tokens.size, 0)
})

test('an owner resets an account whose only membership is their farm', async () => {
  const db = fakeDatabase()
  const issued = await issueResetLink(
    deps(db.store, 'alice'),
    post(),
    farmA,
    'carol',
  )
  assert.equal(issued.username, 'carol_user')
  assert.equal(db.tokens.get('carol')?.ownerFarm, farmA)
  assert.equal(await redeem(db.store, issued.url), true)
  assert.equal(db.accounts.get('carol')?.hash, 'hash:attacker-password-long')
})

test('a link is refused at redemption once the account joined another farm', async () => {
  const db = fakeDatabase()
  const issued = await issueResetLink(
    deps(db.store, 'alice'),
    post(),
    farmA,
    'carol',
  )
  db.memberships.push({
    farm: farmB,
    account: 'carol',
    role: 'operator',
    revoked: false,
  })
  assert.equal(await redeem(db.store, issued.url), false)
  assert.equal(db.accounts.get('carol')?.hash, 'hash:original')
  assert.equal(db.tokens.size, 0, 'the refused link is spent')
})

test('self-service tokens are not bound to a farm', async () => {
  const db = fakeDatabase()
  db.memberships.push({
    farm: farmA,
    account: 'bob',
    role: 'viewer',
    revoked: false,
  })
  const digest = 'a'.repeat(64)
  assert.equal(await db.store.issue('bob_user', digest), true)
  assert.equal(db.tokens.get('bob')?.ownerFarm, null)
})
