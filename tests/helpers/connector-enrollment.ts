// Real Connector enrollment against a disposable, migrated PostgreSQL:
// pairing, proof, approval, credential claim and printer assignment.
// Caller owns the database, the role pools and the private work directory.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Sql } from 'postgres'
import { PostgresPairing } from '../../apps/farm/server/storage/postgres-pairing.ts'
import { PostgresPairingProof } from '../../apps/farm/server/storage/postgres-pairing-proof.ts'
import { PostgresPrinterOwnership } from '../../apps/farm/server/storage/postgres-printer-ownership.ts'
import type { loadOrCreateIdentity } from '../../packages/connector/src/identity/store.ts'

export const ENROLLMENT = {
  issuer: 'https://farm.example',
  audience: 'open3dfarmmanager:connector',
  ttlSeconds: 3600,
} as const

/** Writes `keys.json` (the server's public key registry) into `workDir`. */
export async function enrollConnector(input: {
  admin: Sql
  pairSql: Sql
  ownerSql: Sql
  identity: ReturnType<typeof loadOrCreateIdentity>
  origin: string
  workDir: string
  printerKeys: readonly string[]
}) {
  const { admin, identity, origin } = input
  const keyFile = join(input.workDir, 'keys.json')
  const keys = await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])
  if (!('privateKey' in keys)) throw new Error('Expected key pair')
  const spki = Buffer.from(
    await crypto.subtle.exportKey('spki', keys.publicKey),
  ).toString('base64')
  const pem = `-----BEGIN PUBLIC KEY-----\n${spki.match(/.{1,64}/g)?.join('\n')}\n-----END PUBLIC KEY-----\n`
  writeFileSync(keyFile, JSON.stringify({ fixture: pem }), { mode: 0o600 })

  const now = Date.now(),
    actor = randomUUID(),
    farmId = randomUUID()
  await admin`INSERT INTO farm.session_accounts(id) VALUES(${actor})`
  await admin`INSERT INTO farm.account_sessions(id,account_id,account_version,created_at,last_seen_at,absolute_expires_at) VALUES(${actor},${actor},0,${now},${now},${now + 3_600_000})`
  await admin`INSERT INTO farm.farms(id) VALUES(${farmId}::uuid)`
  await admin`INSERT INTO farm.memberships(farm_id,account_id,role) VALUES(${farmId}::uuid,${actor},'owner')`
  const binding = { origin, audience: 'open3dfarmmanager:pairing' }
  const pairing = new PostgresPairing(input.pairSql, binding)
  const proof = new PostgresPairingProof(admin, binding)
  const started = await pairing.start({
    public_key_spki: identity.publicKeySpki,
    platform: 'linux',
    version: '0.0.1',
  })
  if (!started.ok) throw new Error('Pairing fixture failed')
  const challenge = await proof.issue({
    device_code: started.response.device_code,
  })
  if (!challenge.ok) throw new Error('Pairing challenge failed')
  const completion = await proof.complete({
    device_code: started.response.device_code,
    challenge: challenge.challenge,
    signature: identity.signPairingProof({
      challenge: challenge.challenge,
      expectedOrigin: origin,
      expectedAudience: binding.audience,
      now: Date.now(),
    }),
  })
  assert.equal(completion.ok, true)
  const subject = {
    sessionRecordId: actor,
    policy: { idleTimeoutMs: 3_600_000 },
    farmId,
  }
  const decision = await pairing.decide({
    ...subject,
    decision: 'approve',
    request: {
      user_code: started.response.user_code,
      farm_id: farmId,
      expected_fingerprint: identity.fingerprint,
    },
  })
  assert.equal(decision.ok, true)
  const claimed = await pairing.claim(
    { device_code: started.response.device_code },
    {
      issuer: ENROLLMENT.issuer,
      audience: ENROLLMENT.audience,
      kid: 'fixture',
      privateKey: keys.privateKey,
      ttlSeconds: ENROLLMENT.ttlSeconds,
    },
  )
  if (!claimed.ok || claimed.status !== 'approved')
    throw new Error('Credential fixture failed')
  const { ok: _ok, ...approval } = claimed
  const ownership = new PostgresPrinterOwnership(input.ownerSql)
  const assignments: { printerKey: string; assignmentId: string }[] = []
  for (const printerKey of input.printerKeys) {
    const registered = await ownership.register({
      ...subject,
      agentId: claimed.agent_id,
      printerKey,
    })
    if (!registered.ok) throw new Error('Printer assignment fixture failed')
    assignments.push({ printerKey, assignmentId: registered.assignmentId })
  }
  return { keyFile, farmId, agentId: claimed.agent_id, approval, assignments }
}
