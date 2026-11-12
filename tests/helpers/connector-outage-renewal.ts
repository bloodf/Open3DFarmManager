// Scenario 6: credential renewal due while the farm server is down.
// A fresh enrollment with a short credential lifetime, so renewal falls inside
// the outage and must succeed after the server returns, before hard expiry.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Sql } from 'postgres'
import { PostgresPairing } from '../../apps/farm/server/storage/postgres-pairing.ts'
import { PostgresPairingProof } from '../../apps/farm/server/storage/postgres-pairing-proof.ts'
import { PostgresPrinterOwnership } from '../../apps/farm/server/storage/postgres-printer-ownership.ts'
import { loadOrCreateIdentity } from '../../packages/connector/src/identity/store.ts'
import {
  startConnector,
  type startFakeMoonraker,
  until,
} from './connector-outage-fixtures.ts'

/** Lifetime of the scenario credential and its renewed successor. */
export const RENEWAL_TTL_SECONDS = 90
const PROOF_AUDIENCE = 'open3dfarmmanager:renewal'

export async function credentialRenewalAcrossOutage(input: {
  admin: Sql
  connect: (role: string) => Sql
  rolePrefix: string
  dbPort: number
  workDir: string
  origin: string
  cert: string
  keyFile: string
  keys: CryptoKeyPair
  issuer: string
  audience: string
  moon: Awaited<ReturnType<typeof startFakeMoonraker>>
  restartApp: (extraEnv: Record<string, string>) => Promise<void>
  stopApp: () => Promise<void>
  ledger: (value: object) => void
  dropRoleLater: (role: string) => void
  telemetry: object
}) {
  const { admin, moon, workDir } = input
  const renewer = input.rolePrefix + '_renew'
  await admin`CREATE ROLE ${admin(renewer)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_connector_credential_renewer`
  input.dropRoleLater(renewer)
  input.ledger({ resource: 'database-role', name: renewer })
  const signingKeyPath = join(workDir, 'renewal-signing.pem')
  const pkcs8 = Buffer.from(
    await crypto.subtle.exportKey('pkcs8', input.keys.privateKey),
  ).toString('base64')
  writeFileSync(
    signingKeyPath,
    `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g)?.join('\n')}\n-----END PRIVATE KEY-----\n`,
    { mode: 0o600, flag: 'wx' },
  )
  const ttl = String(RENEWAL_TTL_SECONDS)
  // Credential lifetime is one server-wide setting shared by every acceptance path.
  await input.restartApp({
    NUXT_CONNECTOR_TELEMETRY_TOKEN_TTL_SECONDS: ttl,
    NUXT_CONNECTOR_RENEWAL_ENABLED: 'true',
    NUXT_CONNECTOR_RENEWAL_DATABASE_URL: `postgres://${renewer}:synthetic@127.0.0.1:${input.dbPort}/fixture`,
    NUXT_CONNECTOR_RENEWAL_ORIGIN: input.origin,
    NUXT_CONNECTOR_RENEWAL_ISSUER: input.issuer,
    NUXT_CONNECTOR_RENEWAL_AUDIENCE: input.audience,
    NUXT_CONNECTOR_RENEWAL_PROOF_AUDIENCE: PROOF_AUDIENCE,
    NUXT_CONNECTOR_RENEWAL_SIGNING_KEY_ID: 'fixture',
    NUXT_CONNECTOR_RENEWAL_SIGNING_KEY_PATH: signingKeyPath,
    NUXT_CONNECTOR_RENEWAL_PUBLIC_KEY_REGISTRY_PATH: input.keyFile,
    NUXT_CONNECTOR_RENEWAL_TOKEN_TTL_SECONDS: ttl,
    NUXT_CONNECTOR_RENEWAL_PROOF_TTL_MS: '30000',
    NUXT_CONNECTOR_RENEWAL_BODY_TIMEOUT_MS: '5000',
  })

  // Fresh enrollment: second identity, farm and printer assignment.
  const dataDir = join(workDir, 'renewal-connector')
  const identity = loadOrCreateIdentity(dataDir)
  const now = Date.now(),
    actor = randomUUID(),
    farmId = randomUUID()
  await admin`INSERT INTO farm.session_accounts(id) VALUES(${actor})`
  await admin`INSERT INTO farm.account_sessions(id,account_id,account_version,created_at,last_seen_at,absolute_expires_at) VALUES(${actor},${actor},0,${now},${now},${now + 3_600_000})`
  await admin`INSERT INTO farm.farms(id) VALUES(${farmId}::uuid)`
  await admin`INSERT INTO farm.memberships(farm_id,account_id,role) VALUES(${farmId}::uuid,${actor},'owner')`
  const binding = {
    origin: input.origin,
    audience: 'open3dfarmmanager:pairing',
  }
  const pairing = new PostgresPairing(
    input.connect(input.rolePrefix + '_pair'),
    binding,
  )
  const proof = new PostgresPairingProof(admin, binding)
  const started = await pairing.start({
    public_key_spki: identity.publicKeySpki,
    platform: 'linux',
    version: '0.0.1',
  })
  if (!started.ok) throw new Error('Renewal pairing failed')
  const challenge = await proof.issue({
    device_code: started.response.device_code,
  })
  if (!challenge.ok) throw new Error('Renewal pairing challenge failed')
  assert.equal(
    (
      await proof.complete({
        device_code: started.response.device_code,
        challenge: challenge.challenge,
        signature: identity.signPairingProof({
          challenge: challenge.challenge,
          expectedOrigin: input.origin,
          expectedAudience: binding.audience,
          now: Date.now(),
        }),
      })
    ).ok,
    true,
  )
  const subject = {
    sessionRecordId: actor,
    policy: { idleTimeoutMs: 3_600_000 },
    farmId,
  }
  assert.equal(
    (
      await pairing.decide({
        ...subject,
        decision: 'approve',
        request: {
          user_code: started.response.user_code,
          farm_id: farmId,
          expected_fingerprint: identity.fingerprint,
        },
      })
    ).ok,
    true,
  )
  const claimed = await pairing.claim(
    { device_code: started.response.device_code },
    {
      issuer: input.issuer,
      audience: input.audience,
      kid: 'fixture',
      privateKey: input.keys.privateKey,
      ttlSeconds: RENEWAL_TTL_SECONDS,
    },
  )
  if (!claimed.ok || claimed.status !== 'approved')
    throw new Error('Renewal credential fixture failed')
  const issuedAt = Date.now()
  const { ok: _ok, ...approval } = claimed
  const agentId = claimed.agent_id
  const printerKey = 'renewal-printer'
  const registered = await new PostgresPrinterOwnership(
    input.connect(input.rolePrefix + '_owner'),
  ).register({ ...subject, agentId, printerKey })
  if (!registered.ok) throw new Error('Renewal assignment failed')
  const configPath = join(workDir, 'renewal-runtime.json'),
    credentialPath = join(workDir, 'renewal-credential.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      collection: {
        version: 1,
        allowedOrigins: [moon.origin],
        printers: [{ printerKey, origin: moon.origin }],
        limits: { staleAfterMs: 300000, connectTimeoutMs: 2000 },
      },
      assignments: [
        {
          assignment_id: registered.assignmentId,
          farm_id: farmId,
          agent_id: agentId,
          printer_key: printerKey,
          moonraker_origin: moon.origin,
        },
      ],
      telemetry: {
        endpoint: input.origin + '/api/connector/telemetry',
        audience: input.audience,
        idleMs: 200,
        ...input.telemetry,
      },
      renewal: {
        audience: PROOF_AUDIENCE,
        timeoutMs: 3000,
        retryMinMs: 500,
        retryMaxMs: 2000,
      },
    }),
    { mode: 0o600, flag: 'wx' },
  )
  writeFileSync(
    credentialPath,
    JSON.stringify({
      version: 1,
      expected_fingerprint: identity.fingerprint,
      approval,
    }),
    { mode: 0o600, flag: 'wx' },
  )
  const expiresAt = claimed.expires_at
  const baselinesBefore = moon.baselines.length
  const pushed: number[] = []
  const connector = startConnector({
    args: [
      ...['--config', configPath, '--credential-file', credentialPath],
      ...['--data-dir', dataDir],
    ],
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      NODE_EXTRA_CA_CERTS: input.cert,
    },
    logPath: join(workDir, 'renewal-connector.log'),
    onPid: (pid) => input.ledger({ resource: 'connector-process', pid }),
  })
  try {
    const rows = async () =>
      (await admin`SELECT payload FROM farm.telemetry_events WHERE agent_id=${agentId}::uuid`) as unknown as {
        payload: { state?: { progress: number } }
      }[]
    const expected = () => [...pushed, ...moon.baselines.slice(baselinesBefore)]
    const drained = () =>
      until(
        async () => (await rows()).length >= expected().length,
        30000,
        'renewal connector drained',
      )
    await until(() => connector.count('queued') >= 1, 30000, 'baseline queued')
    await drained()
    // Server down well before the renewal point (50-75 % of the lifetime).
    const lifetimeMs = RENEWAL_TTL_SECONDS * 1000
    const sinceIssue = () => Date.now() - issuedAt
    await until(
      () => sinceIssue() >= lifetimeMs * 0.3,
      lifetimeMs,
      'outage start',
    )
    await input.stopApp()
    const outageStart = Date.now()
    for (let i = 1; i <= 3; i++) {
      const before = connector.count('queued')
      const progress = 0.9 + i / 1000
      moon.push(progress)
      pushed.push(progress)
      await until(() => connector.count('queued') > before, 10000, 'queued')
    }
    // Stay down past the latest renewal point, so renewal is attempted and fails.
    await until(
      () => sinceIssue() >= lifetimeMs * 0.78,
      lifetimeMs,
      'renewal point passed during outage',
    )
    const retriesDuringOutage = connector.count('credential-renewal-retry')
    assert.ok(retriesDuringOutage >= 1, 'renewal retried during outage')
    assert.equal(connector.count('credential-renewed'), 0)
    await input.restartApp({})
    const outageMs = Date.now() - outageStart
    await until(
      () => connector.count('credential-renewed') >= 1,
      Math.max(1000, expiresAt - Date.now()),
      'renewed before expiry',
    )
    const renewedAt = Date.now()
    assert.ok(renewedAt < expiresAt, 'renewal completed before hard expiry')
    const renewed = JSON.parse(readFileSync(credentialPath, 'utf8')) as {
      approval: { expires_at: number; device_token: string }
    }
    assert.ok(renewed.approval.expires_at > expiresAt, 'successor persisted')
    assert.notEqual(renewed.approval.device_token, claimed.device_token)
    await drained()
    const stored = (await rows()).map((r) => r.payload.state?.progress ?? -1)
    const sort = (v: number[]) => [...v].sort((a, b) => a - b)
    assert.deepEqual(sort(stored), sort(expected()), 'exactly once, no loss')
    assert.ok(connector.running, 'Connector survived the renewal outage')
    assert.equal(connector.count('credential-expired'), 0)
    await connector.stop()
    assert.equal((await connector.exited).code, 0)
    return {
      ttlSeconds: RENEWAL_TTL_SECONDS,
      outageMs,
      retriesDuringOutage,
      renewedMsBeforeExpiry: expiresAt - renewedAt,
      rows: stored.length,
    }
  } finally {
    await connector.stop()
  }
}
