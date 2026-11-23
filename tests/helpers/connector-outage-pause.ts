// Pause authority behavior used by both the opt-in outage run and its offline evidence test.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  signCommandV2,
  verifyCommandV2,
} from '../../packages/farm-protocol/src/command-v2.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import { createOfflineAuthority } from '../../packages/connector/src/auth/offline-authority.ts'
import { recordAuthorityStale } from '../../packages/connector/src/runtime/pause-authority-audit.ts'

export const outagePauseScenarioNames = [
  '7-pause-authority-expires-during-server-outage',
  '8-pause-authority-recovers-after-confirmation',
  '9-pause-authority-audit-survives-restart-in-order',
] as const

/** Exercise signed pause authorization and the real durable stale-authority audit, without a printer. */
export async function runOutagePauseScenarios(dataDirectory: string) {
  const browser = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const jwk = await crypto.subtle.exportKey('jwk', browser.publicKey)
  const { publicKey: publicJwk } = await validateBrowserDevicePublicKey({
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
  })
  let sample = { wall: 1000, mono: 1000 }
  const now = () => ({ ...sample })
  const serverSeq = { value: 1 }
  const auditFailures: unknown[] = []
  const authority = createOfflineAuthority({
    maxAgeMs: 1000,
    onStale: (reason) =>
      recordAuthorityStale(
        dataDirectory,
        reason,
        (v) => auditFailures.push(v),
        sample.wall,
      ),
  })
  assert.equal(authority.confirm(now(), serverSeq.value), true)
  async function signedPause() {
    const at = Date.now()
    return signCommandV2(
      {
        v: 2,
        purpose: 'printer-pause',
        cmd_id: randomUUID(),
        farm_id: randomUUID(),
        agent_id: randomUUID(),
        account_id: 'outage-fixture',
        key_id: randomUUID(),
        transport_id: randomUUID(),
        capability_id: randomUUID(),
        assignment_id: randomUUID(),
        action: 'pause',
        args: {},
        issued_at: at,
        expires_at: at + 5000,
        nonce: randomBytes(16).toString('base64url'),
      },
      browser.privateKey,
    )
  }
  const duringOutage = await signedPause()
  sample = { wall: 2001, mono: 2001 }
  const authorize = async (
    command: Awaited<ReturnType<typeof signedPause>>,
    freshAt: (sample: { wall: number; mono: number }) => boolean,
  ) => freshAt(now()) && (await verifyCommandV2(command, publicJwk))
  assert.equal(
    await authorize(duringOutage, authority.freshness.freshAt),
    false,
    'signed pause refused while authority is stale',
  )

  // A new runtime starts stale and cannot infer authority from its predecessor's disk state.
  const auditPath = join(
    dataDirectory,
    'pause-journal',
    'authority-audit.jsonl',
  )
  const staleEventsBeforeRestart = readFileSync(auditPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.deepEqual(
    staleEventsBeforeRestart.map((event) => event.reason),
    ['expired'],
  )
  const recovered = createOfflineAuthority({
    maxAgeMs: 1000,
    onStale: (reason) =>
      recordAuthorityStale(
        dataDirectory,
        reason,
        (v) => auditFailures.push(v),
        sample.wall,
      ),
  })
  assert.equal(recovered.freshness.freshAt(now()), false)
  sample = { wall: 3000, mono: 3000 }
  assert.equal(recovered.confirm(now(), ++serverSeq.value), true)
  const afterRecovery = await signedPause()
  assert.equal(await verifyCommandV2(afterRecovery, publicJwk), true)
  assert.equal(
    await authorize(afterRecovery, recovered.freshness.freshAt),
    true,
    'signed pause accepted after authenticated confirmation',
  )
  sample = { wall: 4001, mono: 4001 }
  assert.equal(recovered.freshness.freshAt(now()), false)
  const auditEvents = readFileSync(auditPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.deepEqual(
    auditEvents.map((event) => event.reason),
    ['expired', 'expired'],
  )
  assert.ok(
    auditEvents[1].at > auditEvents[0].at,
    'audit events remain ordered across restart',
  )
  assert.deepEqual(auditFailures, [])
  return {
    scenarios: [
      {
        name: outagePauseScenarioNames[0],
        result: 'passed',
        signedCommandVerified: true,
        authorityFresh: false,
      },
      {
        name: outagePauseScenarioNames[1],
        result: 'passed',
        signedCommandVerified: true,
        authorityFresh: true,
      },
      {
        name: outagePauseScenarioNames[2],
        result: 'passed',
        persistedEvents: auditEvents.length,
        ordered: true,
      },
    ],
  }
}
