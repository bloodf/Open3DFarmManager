import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import postgres, { type Sql } from 'postgres'
import { PostgresBrowserDeviceRegistry } from '../../apps/farm/server/storage/postgres-browser-device-registry.ts'
import { signBrowserDeviceProof } from '../../packages/farm-protocol/src/browser-device-proof.ts'

/** Caller owns the disposable synthetic database and applies the maintained migration catalog. */
export async function testPostgresBrowserDeviceRegistry(
  admin: Sql,
  port: number,
): Promise<string[]> {
  const role = 'browser_registry_fixture_' + randomUUID().replaceAll('-', '')
  await admin`CREATE ROLE ${admin(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_browser_device_runtime`
  const sql = postgres({
    host: '127.0.0.1',
    port,
    database: 'fixture',
    username: role,
    max: 6,
    connect_timeout: 3,
  })
  let now = 1000
  const policy = { idleTimeoutMs: 1000000000 }
  const config = {
    origin: 'https://farm.example',
    audience: 'open3dfarmmanager:browser-device',
  }
  const registry = new PostgresBrowserDeviceRegistry(sql, config, () => now)
  const checks: string[] = []
  async function seed(memberRole = 'owner', expiry = 1000000000) {
    const account = 'acct_' + randomUUID(),
      session = 'session_' + randomUUID(),
      farm = randomUUID()
    await admin`INSERT INTO farm.session_accounts(id) VALUES (${account})`
    await admin`INSERT INTO farm.account_sessions(id,account_id,account_version,created_at,last_seen_at,absolute_expires_at) VALUES (${session},${account},0,1000,1000,${expiry})`
    await admin`INSERT INTO farm.farms(id) VALUES (${farm}::uuid)`
    await admin`INSERT INTO farm.memberships(farm_id,account_id,role) VALUES (${farm}::uuid,${account},${memberRole})`
    return { account, session, farm }
  }
  async function key() {
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign', 'verify'],
    )
    const { kty, crv, x, y } = await crypto.subtle.exportKey(
      'jwk',
      pair.publicKey,
    )
    return { pair, publicKey: { kty, crv, x, y } }
  }
  async function issue(
    owner: Awaited<ReturnType<typeof seed>>,
    k: Awaited<ReturnType<typeof key>>,
    purpose: 'enroll' | 'recover' = 'enroll',
  ) {
    return registry.issueChallenge({
      sessionRecordId: owner.session,
      policy,
      request: { farm_id: owner.farm, public_key: k.publicKey, purpose },
    })
  }
  async function complete(
    owner: Awaited<ReturnType<typeof seed>>,
    k: Awaited<ReturnType<typeof key>>,
    challenge: Extract<
      Awaited<ReturnType<typeof issue>>,
      { ok: true }
    >['challenge'],
  ) {
    return registry.completeProof({
      sessionRecordId: owner.session,
      policy,
      request: {
        challenge_id: challenge.challenge_id,
        signature: await signBrowserDeviceProof(challenge, k.pair.privateKey),
      },
    })
  }
  function decision(
    owner: Awaited<ReturnType<typeof seed>>,
    challenge: Extract<
      Awaited<ReturnType<typeof issue>>,
      { ok: true }
    >['challenge'],
  ) {
    return {
      sessionRecordId: owner.session,
      policy,
      request: {
        farm_id: challenge.farm_id,
        key_id: challenge.key_id,
        expected_thumbprint: challenge.thumbprint,
      },
    }
  }
  try {
    const owner = await seed(),
      k = await key(),
      issued = await issue(owner, k)
    assert.ok(issued.ok)
    assert.notEqual(issued.challenge.session_id, owner.session)
    assert.equal(
      JSON.stringify(issued.challenge).includes(owner.session),
      false,
    )
    const signature = await signBrowserDeviceProof(
      issued.challenge,
      k.pair.privateKey,
    )
    const request = {
      sessionRecordId: owner.session,
      policy,
      request: { challenge_id: issued.challenge.challenge_id, signature },
    }
    const race = await Promise.all([
      registry.completeProof(request),
      registry.completeProof(request),
    ])
    assert.equal(race.filter((result) => result.ok).length, 1)
    assert.equal(
      race.filter((result) => !result.ok && result.reason === 'denied').length,
      1,
    )
    assert.deepEqual(await registry.completeProof(request), {
      ok: false,
      reason: 'denied',
    })
    now += 61000
    assert.equal(
      (await registry.approve(decision(owner, issued.challenge))).ok,
      true,
    )
    checks.push(
      'real-webcrypto-proof-single-consumption-race-and-late-approval',
    )
    const recovery = await issue(owner, k, 'recover')
    assert.ok(recovery.ok)
    assert.equal(recovery.challenge.key_id, issued.challenge.key_id)
    assert.ok((await complete(owner, k, recovery.challenge)).ok)
    const current = {
      sessionRecordId: owner.session,
      policy,
      request: {
        farm_id: owner.farm,
        key_id: recovery.challenge.key_id,
        proof_session_id: recovery.challenge.session_id,
      },
    }
    assert.ok((await registry.authorizeDevice(current)).ok)
    for (const altered of [
      { ...config, origin: 'https://other.example' },
      { ...config, audience: 'other' },
    ]) {
      const otherRegistry = new PostgresBrowserDeviceRegistry(
        sql,
        altered,
        () => now,
      )
      assert.deepEqual(await otherRegistry.authorizeDevice(current), {
        ok: false,
        reason: 'denied',
      })
    }
    now = recovery.challenge.expires_at
    assert.deepEqual(await registry.authorizeDevice(current), {
      ok: false,
      reason: 'denied',
    })
    checks.push('approved-key-recovery-and-proof-session-expiry')

    const outsider = await seed()
    assert.deepEqual(
      await registry.approve({
        ...decision(owner, issued.challenge),
        sessionRecordId: outsider.session,
      }),
      { ok: false, reason: 'denied' },
    )
    assert.equal(
      (await registry.revoke(decision(owner, issued.challenge))).ok,
      true,
    )
    assert.deepEqual(
      await registry.approve(decision(owner, issued.challenge)),
      { ok: false, reason: 'denied' },
    )
    assert.deepEqual(await issue(owner, k, 'recover'), {
      ok: false,
      reason: 'denied',
    })
    const replacement = await issue(owner, await key())
    assert.ok(replacement.ok)
    assert.notEqual(replacement.challenge.key_id, issued.challenge.key_id)
    checks.push('cross-farm-denial-terminal-revocation-and-new-key-enrollment')
    for (const roleName of ['operator', 'viewer']) {
      const actor = await seed(roleName),
        actorKey = await key(),
        challenge = await issue(actor, actorKey)
      assert.ok(challenge.ok)
      assert.ok((await complete(actor, actorKey, challenge.challenge)).ok)
      assert.deepEqual(
        await registry.approve(decision(actor, challenge.challenge)),
        { ok: false, reason: 'denied' },
      )
    }
    for (const roleName of ['owner', 'admin']) {
      const actor = await seed(roleName),
        actorKey = await key(),
        challenge = await issue(actor, actorKey)
      assert.ok(challenge.ok)
      assert.ok((await complete(actor, actorKey, challenge.challenge)).ok)
      assert.ok(
        (await registry.approve(decision(actor, challenge.challenge))).ok,
      )
    }
    checks.push('owner-admin-only-approval')
    const shared = await seed(),
      sharedKey = await key(),
      sharedChallenge = await issue(shared, sharedKey)
    assert.ok(sharedChallenge.ok)
    assert.ok((await complete(shared, sharedKey, sharedChallenge.challenge)).ok)
    const second = await seed('admin')
    await admin`INSERT INTO farm.memberships(farm_id,account_id,role) VALUES (${shared.farm}::uuid,${second.account},'admin')`
    assert.ok(
      (
        await registry.approve({
          ...decision(shared, sharedChallenge.challenge),
          sessionRecordId: second.session,
        })
      ).ok,
    )
    const snapshot = {
      sessionRecordId: shared.session,
      policy,
      request: {
        farm_id: shared.farm,
        key_id: sharedChallenge.challenge.key_id,
        proof_session_id: sharedChallenge.challenge.session_id,
      },
    }
    const firstSnapshot = await registry.authorizeDevice(snapshot)
    assert.ok(firstSnapshot.ok)
    assert.equal(firstSnapshot.role, 'owner')
    await admin`UPDATE farm.memberships SET role='viewer' WHERE farm_id=${shared.farm}::uuid AND account_id=${shared.account}`
    const downgraded = await registry.authorizeDevice(snapshot)
    assert.ok(downgraded.ok)
    assert.equal(downgraded.role, 'viewer')
    assert.deepEqual(
      await registry.authorizeDevice({
        ...snapshot,
        request: { ...snapshot.request, proof_session_id: randomUUID() },
      }),
      { ok: false, reason: 'denied' },
    )
    await admin`UPDATE farm.memberships SET revoked_at=${now} WHERE farm_id=${shared.farm}::uuid AND account_id=${shared.account}`
    assert.deepEqual(await registry.authorizeDevice(snapshot), {
      ok: false,
      reason: 'denied',
    })
    checks.push('distinct-admin-approval-live-role-and-session-scoped-lookup')
    const left = await seed(),
      right = await seed(),
      leftKey = await key(),
      rightKey = await key()
    await admin`INSERT INTO farm.memberships(farm_id,account_id,role) VALUES (${left.farm}::uuid,${right.account},'owner')`
    const leftProof = await issue(left, leftKey)
    const rightOnFarm = { ...right, farm: left.farm }
    const rightProof = await issue(rightOnFarm, rightKey)
    assert.ok(leftProof.ok && rightProof.ok)
    assert.ok((await complete(left, leftKey, leftProof.challenge)).ok)
    assert.ok((await complete(rightOnFarm, rightKey, rightProof.challenge)).ok)
    const opposite = await Promise.all([
      registry.approve({
        ...decision(left, leftProof.challenge),
        sessionRecordId: right.session,
      }),
      registry.approve({
        ...decision(rightOnFarm, rightProof.challenge),
        sessionRecordId: left.session,
      }),
    ])
    assert.equal(opposite.filter((result) => result.ok).length, 2)
    checks.push('opposite-actor-owner-approval-completes-concurrently')

    const badOwner = await seed(),
      badKey = await key(),
      bad = await issue(badOwner, badKey)
    assert.ok(bad.ok)
    const wrong = await key()
    const badSignature = await signBrowserDeviceProof(
      bad.challenge,
      wrong.pair.privateKey,
    )
    assert.deepEqual(
      await registry.completeProof({
        sessionRecordId: badOwner.session,
        policy,
        request: {
          challenge_id: bad.challenge.challenge_id,
          signature: badSignature,
        },
      }),
      { ok: false, reason: 'denied' },
    )
    assert.deepEqual(await complete(badOwner, badKey, bad.challenge), {
      ok: false,
      reason: 'denied',
    })
    assert.ok((await issue(badOwner, badKey)).ok)
    checks.push('bad-signature-consumed-durably-and-new-attempt-allowed')
    for (const kind of ['session', 'account', 'membership', 'downgrade']) {
      const subject = await seed(),
        subjectKey = await key(),
        proof = await issue(subject, subjectKey)
      assert.ok(proof.ok)
      if (kind === 'session')
        await admin`UPDATE farm.account_sessions SET revoked_at=${now} WHERE id=${subject.session}`
      if (kind === 'account')
        await admin`UPDATE farm.session_accounts SET disabled=true WHERE id=${subject.account}`
      if (kind === 'membership')
        await admin`UPDATE farm.memberships SET revoked_at=${now} WHERE farm_id=${subject.farm}::uuid AND account_id=${subject.account}`
      if (kind === 'downgrade')
        await admin`UPDATE farm.memberships SET role='viewer' WHERE farm_id=${subject.farm}::uuid AND account_id=${subject.account}`
      const result = await complete(subject, subjectKey, proof.challenge)
      if (kind === 'downgrade') {
        assert.ok(result.ok)
        assert.deepEqual(
          await registry.approve(decision(subject, proof.challenge)),
          { ok: false, reason: 'denied' },
        )
      } else assert.deepEqual(result, { ok: false, reason: 'denied' })
    }
    checks.push('session-account-membership-revocation-and-actor-downgrade')
    for (const kind of ['session', 'account', 'membership', 'expiry']) {
      const subject = await seed(),
        subjectKey = await key(),
        proof = await issue(subject, subjectKey)
      assert.ok(proof.ok)
      const blocker = await admin.reserve()
      await blocker`BEGIN`
      if (kind === 'membership')
        await blocker`UPDATE farm.memberships SET revoked_at=${now} WHERE farm_id=${subject.farm}::uuid AND account_id=${subject.account}`
      else
        await blocker`SELECT id FROM farm.session_accounts WHERE id=${subject.account} FOR UPDATE`
      if (kind === 'session')
        await blocker`UPDATE farm.account_sessions SET revoked_at=${now} WHERE id=${subject.session}`
      if (kind === 'account')
        await blocker`UPDATE farm.session_accounts SET disabled=true WHERE id=${subject.account}`
      const pending = complete(subject, subjectKey, proof.challenge)
      try {
        const deadline = performance.now() + 1500
        while (true) {
          const waits =
            await admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename=${role} AND wait_event_type='Lock'`
          if (waits[0]?.n > 0) break
          assert.ok(
            performance.now() < deadline,
            'Expected authorization lock wait',
          )
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
        if (kind === 'expiry') now = proof.challenge.expires_at
      } finally {
        await blocker`COMMIT`
        blocker.release()
      }
      assert.deepEqual(await pending, { ok: false, reason: 'denied' })
    }
    checks.push('revocation-and-expiry-after-authorization-lock-wait')

    const member = await seed(),
      memberKey = await key(),
      challenge = await issue(member, memberKey)
    assert.ok(challenge.ok)
    assert.ok((await complete(member, memberKey, challenge.challenge)).ok)
    const adminActor = await seed('admin')
    await admin`INSERT INTO farm.memberships(farm_id,account_id,role) VALUES (${member.farm}::uuid,${adminActor.account},'admin')`
    await admin`UPDATE farm.memberships SET revoked_at=${now} WHERE farm_id=${member.farm}::uuid AND account_id=${member.account}`
    assert.deepEqual(
      await registry.approve({
        ...decision(member, challenge.challenge),
        sessionRecordId: adminActor.session,
      }),
      { ok: false, reason: 'denied' },
    )
    assert.ok(
      (
        await registry.revoke({
          ...decision(member, challenge.challenge),
          sessionRecordId: adminActor.session,
        })
      ).ok,
    )
    checks.push('admin-revokes-after-owning-membership-removal')
    for (const kind of [
      'session',
      'account',
      'membership',
      'downgrade',
      'owner-expiry',
    ]) {
      const target = await seed(
          'owner',
          kind === 'owner-expiry' ? now + 1000 : 1000000000,
        ),
        targetKey = await key(),
        proof = await issue(target, targetKey)
      assert.ok(proof.ok)
      assert.ok((await complete(target, targetKey, proof.challenge)).ok)
      const actor = await seed('admin')
      await admin`INSERT INTO farm.memberships(farm_id,account_id,role) VALUES (${target.farm}::uuid,${actor.account},'admin')`
      const blocker = await admin.reserve()
      await blocker`BEGIN`
      if (kind === 'membership' || kind === 'downgrade') {
        if (kind === 'membership')
          await blocker`UPDATE farm.memberships SET revoked_at=${now} WHERE farm_id=${target.farm}::uuid AND account_id=${actor.account}`
        else
          await blocker`UPDATE farm.memberships SET role='viewer' WHERE farm_id=${target.farm}::uuid AND account_id=${actor.account}`
      } else {
        await blocker`SELECT id FROM farm.session_accounts WHERE id=${kind === 'owner-expiry' ? target.account : actor.account} FOR UPDATE`
        if (kind === 'session')
          await blocker`UPDATE farm.account_sessions SET revoked_at=${now} WHERE id=${actor.session}`
        if (kind === 'account')
          await blocker`UPDATE farm.session_accounts SET disabled=true WHERE id=${actor.account}`
      }
      const pending = registry.approve({
        ...decision(target, proof.challenge),
        sessionRecordId: actor.session,
      })
      const beforeWait = now
      try {
        const deadline = performance.now() + 1500
        while (true) {
          const waits =
            await admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename=${role} AND wait_event_type='Lock'`
          if (waits[0]?.n > 0) break
          assert.ok(
            performance.now() < deadline,
            'Expected approval authorization lock wait',
          )
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
        if (kind === 'owner-expiry') now = beforeWait + 1000
      } finally {
        await blocker`COMMIT`
        blocker.release()
      }
      assert.deepEqual(await pending, { ok: false, reason: 'denied' })
      now = beforeWait
    }
    checks.push(
      'approval-observes-approver-revocation-downgrade-and-owner-expiry-after-lock-wait',
    )
    checks.push('owning-membership-must-remain-active-for-approval')
    for (const first of ['complete', 'revoke']) {
      const subject = await seed(),
        subjectKey = await key(),
        proof = await issue(subject, subjectKey)
      assert.ok(proof.ok)
      const blocker = await admin.reserve()
      await blocker`BEGIN`
      await blocker`SELECT pg_advisory_xact_lock(1870033,13)`
      const start = (operation: string) =>
        operation === 'complete'
          ? complete(subject, subjectKey, proof.challenge)
          : registry.revoke(decision(subject, proof.challenge))
      const pending: ReturnType<typeof start>[] = []
      try {
        const deadline = performance.now() + 1500
        for (const count of [1, 2]) {
          pending.push(
            start(
              count === 1
                ? first
                : first === 'complete'
                  ? 'revoke'
                  : 'complete',
            ),
          )
          while (true) {
            const waits =
              await admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename=${role} AND wait_event_type='Lock'`
            if (waits[0]?.n >= count) break
            assert.ok(
              performance.now() < deadline,
              'Expected ordered registry lock wait',
            )
            await new Promise((resolve) => setTimeout(resolve, 5))
          }
        }
      } finally {
        await blocker`COMMIT`
        blocker.release()
      }
      const [firstResult, secondResult] = await Promise.all(pending)
      assert.ok(firstResult && secondResult)
      assert.ok(firstResult.ok)
      if (first === 'complete') assert.ok(secondResult.ok)
      else assert.deepEqual(secondResult, { ok: false, reason: 'denied' })
      assert.deepEqual(
        await registry.approve(decision(subject, proof.challenge)),
        { ok: false, reason: 'denied' },
      )
      assert.equal(
        (
          await admin`SELECT status FROM farm.browser_device_keys WHERE key_id=${proof.challenge.key_id}::uuid`
        )[0]?.status,
        'revoked',
      )
    }
    checks.push('completion-and-key-revocation-both-lock-orders')
    for (const first of ['snapshot', 'revoke']) {
      const subject = await seed(),
        subjectKey = await key(),
        proof = await issue(subject, subjectKey)
      assert.ok(proof.ok)
      assert.ok((await complete(subject, subjectKey, proof.challenge)).ok)
      assert.ok((await registry.approve(decision(subject, proof.challenge))).ok)
      const snapshot = {
        sessionRecordId: subject.session,
        policy,
        request: {
          farm_id: subject.farm,
          key_id: proof.challenge.key_id,
          proof_session_id: proof.challenge.session_id,
        },
      }
      const blocker = await admin.reserve()
      await blocker`BEGIN`
      await blocker`SELECT pg_advisory_xact_lock(1870033,13)`
      const start = (operation: string) =>
        operation === 'snapshot'
          ? registry.authorizeDevice(snapshot)
          : registry.revoke(decision(subject, proof.challenge))
      const pending: ReturnType<typeof start>[] = []
      try {
        const deadline = performance.now() + 1500
        for (const count of [1, 2]) {
          pending.push(
            start(
              count === 1
                ? first
                : first === 'snapshot'
                  ? 'revoke'
                  : 'snapshot',
            ),
          )
          while (true) {
            const waits =
              await admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename=${role} AND wait_event_type='Lock'`
            if (waits[0]?.n >= count) break
            assert.ok(
              performance.now() < deadline,
              'Expected ordered registry lock wait',
            )
            await new Promise((resolve) => setTimeout(resolve, 5))
          }
        }
      } finally {
        await blocker`COMMIT`
        blocker.release()
      }
      const [a, b] = await Promise.all(pending)
      assert.ok(a && b)
      assert.ok(a.ok)
      if (first === 'snapshot') assert.ok(b.ok)
      else assert.deepEqual(b, { ok: false, reason: 'denied' })
      assert.equal(
        (
          await admin`SELECT status FROM farm.browser_device_keys WHERE key_id=${proof.challenge.key_id}::uuid`
        )[0]?.status,
        'revoked',
      )
    }
    checks.push('snapshot-and-key-revocation-both-lock-orders')

    const expOwner = await seed(),
      expKey = await key(),
      exp = await issue(expOwner, expKey)
    assert.ok(exp.ok)
    now = exp.challenge.expires_at
    assert.deepEqual(await complete(expOwner, expKey, exp.challenge), {
      ok: false,
      reason: 'denied',
    })
    checks.push('expiry-at-boundary')
    const oldOwner = await seed(),
      oldKey = await key(),
      oldProof = await issue(oldOwner, oldKey)
    assert.ok(oldProof.ok)
    assert.ok((await complete(oldOwner, oldKey, oldProof.challenge)).ok)
    now += 86400000
    assert.deepEqual(
      await registry.approve(decision(oldOwner, oldProof.challenge)),
      { ok: false, reason: 'denied' },
    )
    assert.deepEqual(await issue(oldOwner, oldKey, 'recover'), {
      ok: false,
      reason: 'denied',
    })
    checks.push('pending-registration-lifetime-is-independent-of-proof-expiry')
    const capped = await seed()
    for (let index = 0; index < 32; index++)
      assert.ok((await issue(capped, await key())).ok)
    assert.deepEqual(await issue(capped, await key()), {
      ok: false,
      reason: 'capacity',
    })
    checks.push('per-account-farm-key-allocation-cap')
    const attemptsOwner = await seed(),
      attemptsKey = await key()
    for (let index = 0; index < 3; index++) {
      const attempt = await issue(attemptsOwner, attemptsKey)
      assert.ok(attempt.ok)
      const wrongKey = await key()
      const signature = await signBrowserDeviceProof(
        attempt.challenge,
        wrongKey.pair.privateKey,
      )
      assert.deepEqual(
        await registry.completeProof({
          sessionRecordId: attemptsOwner.session,
          policy,
          request: { challenge_id: attempt.challenge.challenge_id, signature },
        }),
        { ok: false, reason: 'denied' },
      )
    }
    assert.deepEqual(await issue(attemptsOwner, attemptsKey), {
      ok: false,
      reason: 'capacity',
    })
    checks.push('three-attempt-lifetime-cap')

    for (const query of [
      'DELETE FROM farm.browser_device_keys',
      'TRUNCATE farm.browser_device_challenges',
      "UPDATE farm.browser_device_keys SET thumbprint = repeat('A',43)",
      'CREATE TABLE farm.forbidden_browser_test(id int)',
      'SET ROLE fixture',
    ])
      await assert.rejects(sql.unsafe(query))
    await assert.rejects(
      admin`UPDATE farm.browser_device_keys SET thumbprint=${'A'.repeat(43)} WHERE key_id=${issued.challenge.key_id}::uuid`,
    )
    for (const malformed of [
      { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43) },
      { ...k.publicKey, d: 'A'.repeat(43) },
    ]) {
      await assert.rejects(
        admin`INSERT INTO farm.browser_device_keys(key_id,farm_id,account_id,public_key,thumbprint,created_at) VALUES (${randomUUID()}::uuid,${owner.farm}::uuid,${owner.account},${admin.json(malformed)},${'A'.repeat(43)},${now})`,
      )
    }
    await assert.rejects(
      admin`UPDATE farm.browser_device_keys SET status='approved' WHERE key_id=${issued.challenge.key_id}::uuid`,
    )
    const reopenedSql = postgres({
      host: '127.0.0.1',
      port,
      database: 'fixture',
      username: role,
      max: 2,
      connect_timeout: 3,
    })
    try {
      const reopened = new PostgresBrowserDeviceRegistry(
        reopenedSql,
        config,
        () => now,
      )
      assert.deepEqual(await reopened.completeProof(request), {
        ok: false,
        reason: 'denied',
      })
      assert.deepEqual(
        await reopened.approve(decision(owner, issued.challenge)),
        { ok: false, reason: 'denied' },
      )
    } finally {
      await reopenedSql.end({ timeout: 3 })
    }
    checks.push('fresh-connection-replay-and-revocation-persistence')
    checks.push('restricted-sql-role-and-immutable-key-binding')
  } finally {
    await sql.end({ timeout: 3 })
    await admin`DROP ROLE ${admin(role)}`
  }
  assert.deepEqual(
    await registry.issueChallenge({
      sessionRecordId: 'missing',
      policy,
      request: {
        farm_id: randomUUID(),
        public_key: (await key()).publicKey,
        purpose: 'enroll',
      },
    }),
    { ok: false, reason: 'storage-unavailable' },
  )
  return [...checks, 'closed-storage-fails-closed']
}
