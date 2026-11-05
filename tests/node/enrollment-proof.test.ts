import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import {
  EnrolledConnectorProof,
  type EnrollmentRecord,
  type EnrollmentSource,
  type EnrollmentScope,
} from '../../apps/farm/server/services/enrolled-connector-proof.ts'

const id = '00000000-0000-4000-8000-000000000001'
const other = '00000000-0000-4000-8000-000000000002'
const scope = { farmId: id, agentId: id }
/** Test-only trusted fixtures: these mutations are NOT permission-checked approval endpoints. */
class FixtureEnrollment implements EnrollmentSource {
  record: EnrollmentRecord | null = null
  fail: 'before' | 'after' | null = null
  async withEnrollment(
    _scope: EnrollmentScope,
    check: (record: EnrollmentRecord | null) => void,
  ): Promise<void> {
    if (this.fail === 'before') throw new Error('Synthetic lookup failure')
    check(structuredClone(this.record))
    if (this.fail === 'after') throw new Error('Synthetic transaction failure')
  }
  approveForTest(): void {
    if (!this.record || this.record.status !== 'pending')
      throw new Error('Not pending')
    this.record.status = 'approved'
  }
  revokeForTest(): void {
    if (this.record) this.record.status = 'revoked'
  }
}
function fixture() {
  const identity = new ConnectorIdentity(
    generateKeyPairSync('ed25519').privateKey,
  )
  const source = new FixtureEnrollment()
  source.record = {
    ...scope,
    status: 'pending',
    publicKeySpki: identity.publicKeySpki,
    fingerprint: identity.fingerprint,
  }
  const service = new EnrolledConnectorProof(source)
  return { identity, source, service }
}

test('unpaired and pending identities cannot obtain challenges; approved fixture can prove possession once', async () => {
  const { identity, source, service } = fixture()
  assert.equal(await service.issue(scope, id, () => 1000, 5000), null)
  source.approveForTest()
  const challenge = await service.issue(scope, id, () => 1000, 5000)
  assert.ok(challenge)
  const signature = identity.signProof(
    Buffer.from(challenge.nonce, 'base64url'),
  )
  assert.equal(
    await service.complete(scope, id, challenge.nonce, signature, () => 1001),
    true,
  )
  assert.equal(
    await service.complete(scope, id, challenge.nonce, signature, () => 1001),
    false,
  )
  source.record = null
  assert.equal(await service.issue(scope, id, () => 1001, 5000), null)
})
test('revocation during a pending challenge rejects completion and prevents reapproval of the same fixture', async () => {
  const { identity, source, service } = fixture()
  source.approveForTest()
  const challenge = await service.issue(scope, id, () => 1000, 5000)
  assert.ok(challenge)
  source.revokeForTest()
  assert.equal(
    await service.complete(
      scope,
      id,
      challenge.nonce,
      identity.signProof(Buffer.from(challenge.nonce, 'base64url')),
      () => 1001,
    ),
    false,
  )
  assert.equal(await service.issue(scope, id, () => 1001, 5000), null)
  assert.throws(() => source.approveForTest(), /Not pending/)
})
test('wrong farm, substituted record and unenrolled signing key cannot establish possession', async () => {
  const { source, service } = fixture()
  source.approveForTest()
  assert.equal(
    await service.issue({ ...scope, farmId: other }, id, () => 1000, 5000),
    null,
  )
  const challenge = await service.issue(scope, id, () => 1000, 5000)
  assert.ok(challenge)
  const stranger = fixture().identity
  assert.equal(
    await service.complete(
      scope,
      id,
      challenge.nonce,
      stranger.signProof(Buffer.from(challenge.nonce, 'base64url')),
      () => 1001,
    ),
    false,
  )
  source.record!.agentId = other
  assert.equal(await service.issue(scope, id, () => 1001, 5000), null)
})
test('lookup outage denies completion and discards the pending challenge even after recovery', async () => {
  const { identity, source, service } = fixture()
  source.approveForTest()
  const challenge = await service.issue(scope, id, () => 1000, 5000)
  assert.ok(challenge)
  const proof = identity.signProof(Buffer.from(challenge.nonce, 'base64url'))
  source.fail = 'before'
  assert.equal(
    await service.complete(scope, id, challenge.nonce, proof, () => 1001),
    false,
  )
  source.fail = null
  assert.equal(
    await service.complete(scope, id, challenge.nonce, proof, () => 1001),
    false,
  )
})
test('read transaction failure after proof evaluation never returns success or permits replay', async () => {
  const { identity, source, service } = fixture()
  source.approveForTest()
  const challenge = await service.issue(scope, id, () => 1000, 5000)
  assert.ok(challenge)
  const proof = identity.signProof(Buffer.from(challenge.nonce, 'base64url'))
  source.fail = 'after'
  assert.equal(
    await service.complete(scope, id, challenge.nonce, proof, () => 1001),
    false,
  )
  source.fail = null
  assert.equal(
    await service.complete(scope, id, challenge.nonce, proof, () => 1001),
    false,
  )
})
test('source adapters that skip or repeat the callback cannot issue a challenge', async () => {
  const { source } = fixture()
  source.approveForTest()
  for (const count of [0, 2]) {
    const service = new EnrolledConnectorProof({
      withEnrollment: async (_scope, check) => {
        for (let i = 0; i < count; i++) check(structuredClone(source.record))
      },
    })
    assert.equal(await service.issue(scope, id, () => 1000, 5000), null)
  }
})

test('source callback after transaction completion cannot create or evaluate a challenge', async () => {
  const { source } = fixture()
  source.approveForTest()
  let late!: (record: EnrollmentRecord | null) => void
  let clockCalls = 0
  const service = new EnrolledConnectorProof({
    withEnrollment: async (_scope, check) => {
      late = check
    },
  })
  assert.equal(
    await service.issue(
      scope,
      id,
      () => {
        clockCalls++
        return 1000
      },
      5000,
    ),
    null,
  )
  late(source.record)
  assert.equal(clockCalls, 0)
})

test('closing connection while enrollment lookup waits prevents late challenge issuance', async () => {
  const { source } = fixture()
  source.approveForTest()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const service = new EnrolledConnectorProof({
    withEnrollment: async (_scope, check) => {
      await gate
      check(source.record)
    },
  })
  const pending = service.issue(scope, id, () => 1000, 5000)
  service.discardConnection(id)
  release()
  assert.equal(await pending, null)
})

test('closing connection after proof evaluation but before commit prevents success', async () => {
  const { source, identity } = fixture()
  source.approveForTest()
  let hold = false
  let release!: () => void
  let evaluated!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const reached = new Promise<void>((resolve) => {
    evaluated = resolve
  })
  const service = new EnrolledConnectorProof({
    withEnrollment: async (_scope, check) => {
      check(source.record)
      if (hold) {
        evaluated()
        await gate
      }
    },
  })
  const challenge = await service.issue(scope, id, () => 1000, 5000)
  assert.ok(challenge)
  hold = true
  const completion = service.complete(
    scope,
    id,
    challenge.nonce,
    identity.signProof(Buffer.from(challenge.nonce, 'base64url')),
    () => 1001,
  )
  await reached
  service.discardConnection(id)
  release()
  assert.equal(await completion, false)
})

test('closing one pending connection does not cancel another connection proof', async () => {
  const { source, identity } = fixture()
  source.approveForTest()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const service = new EnrolledConnectorProof({
    withEnrollment: async (_scope, check) => {
      await gate
      check(source.record)
    },
  })
  const closed = service.issue(scope, id, () => 1000, 5000)
  const live = service.issue(scope, other, () => 1000, 5000)
  service.discardConnection(id)
  release()
  assert.equal(await closed, null)
  const challenge = await live
  assert.ok(challenge)
  assert.equal(
    await service.complete(
      scope,
      other,
      challenge.nonce,
      identity.signProof(Buffer.from(challenge.nonce, 'base64url')),
      () => 1001,
    ),
    true,
  )
})
