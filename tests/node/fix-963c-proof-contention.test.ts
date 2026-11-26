/**
 * #963: telemetry uploads and WebRTC admission share one credential proof
 * slot. A pending telemetry challenge must not make an interactive admission
 * wait for it to lapse, and every proof stays single-use. Disposable Postgres
 * and loopback only; no printer is contacted.
 */
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import type { Sql } from 'postgres'
import postgres from 'postgres'
import { PostgresConnectorCredentialAcceptance } from '../../apps/farm/server/storage/postgres-connector-credential-acceptance.ts'
import {
  connectorKeyBinding,
  issueConnectorCredential,
} from '../../apps/farm/server/utils/connector-credentials.ts'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import {
  disposablePostgres,
  findPostgresBin,
} from '../helpers/disposable-postgres.ts'
import { vitestPostgresOptions } from '../helpers/vitest-postgres.ts'

let missing = ''
if (process.env.OPENFARM_PG !== 'docker') {
  try {
    findPostgresBin()
  } catch (error) {
    missing = String(error)
  }
}
if (missing && process.env.CI) throw new Error(missing)

const ORIGIN = 'https://farm.example'
const AUDIENCE = 'open3dfarmmanager:connector'
const KID = 'fix-963c'
const TTL_SECONDS = 120

test(
  'an interactive admission retires a pending telemetry challenge, never the reverse',
  { timeout: 120_000, skip: missing || false },
  async (t) => {
    const database = disposablePostgres({
      ...vitestPostgresOptions('openfarm-fix-963c'),
      isolated: true,
    })
    t.after(() => database.stop())
    const admin = await database.start()
    const fixture = await enrol(admin)
    const pools: Sql[] = []
    t.after(() => Promise.all(pools.map((sql) => sql.end({ timeout: 3 }))))
    const password = randomBytes(24).toString('hex')
    const login = async (role: string, parent: string) => {
      await admin.unsafe(
        `CREATE ROLE ${role} LOGIN PASSWORD '${password}' IN ROLE ${parent}`,
      )
      const sql = postgres({
        host: '127.0.0.1',
        port: database.port,
        database: 'fixture',
        username: role,
        password,
        ssl: false,
        max: 2,
        connect_timeout: 3,
        onnotice: () => {},
      })
      pools.push(sql)
      return sql
    }
    let now = Date.now()
    const config = {
      issuer: ORIGIN,
      audience: AUDIENCE,
      origin: ORIGIN,
      purpose: 'signalling' as const,
      publicKeys: new Map([[KID, fixture.signer.publicKey]]),
      ttlSeconds: TTL_SECONDS,
      proofTtlMs: 8000,
    }
    const signalling = new PostgresConnectorCredentialAcceptance(
      await login('fix_963c_signalling', 'farm_connector_credential_acceptor'),
      config,
      () => now,
    )
    const telemetry = new PostgresConnectorCredentialAcceptance(
      await login('fix_963c_telemetry', 'farm_connector_telemetry_writer'),
      { ...config, purpose: 'telemetry-ingestion' },
      () => now,
    )
    const { identity } = fixture
    const committedEvents = async (eventId: string) =>
      (
        await admin`SELECT count(*)::int AS n FROM farm.telemetry_events WHERE event_id=${eventId}::uuid`
      )[0]!.n as number

    for (const [kind, token] of [
      ['root', fixture.root],
      ['successor', fixture.successor],
    ] as const) {
      const common = { token, agentId: fixture.agentId, farmId: fixture.farmId }
      const batch = () => {
        const eventId = randomUUID()
        const body = Buffer.from(
          JSON.stringify([
            {
              eventId,
              queuedAt: now,
              kind: 'printer-state',
              state: {
                printerKey: fixture.printerKey,
                state: 'idle',
                progress: 0,
                observedAt: now,
              },
            },
          ]),
        )
        return { eventId, body }
      }
      const telemetryProof = (
        request: { connectionId: string },
        challenge: Parameters<
          ConnectorIdentity['signTelemetryProof']
        >[0]['challenge'],
        body: Buffer,
      ) => ({
        ...common,
        ...request,
        challenge,
        signature: identity.signTelemetryProof({
          challenge,
          token,
          body,
          expectedOrigin: ORIGIN,
          expectedAudience: AUDIENCE,
          expectedConnectionId: request.connectionId,
          now,
        }),
      })
      const signallingProof = (
        request: { connectionId: string },
        challenge: Parameters<
          ConnectorIdentity['signCredentialProof']
        >[0]['challenge'],
      ) => ({
        ...common,
        ...request,
        challenge,
        signature: identity.signCredentialProof({
          challenge,
          token,
          expectedOrigin: ORIGIN,
          expectedAudience: AUDIENCE,
          expectedPurpose: 'signalling',
          expectedConnectionId: request.connectionId,
          now,
        }),
      })

      // 1. A telemetry upload holds the slot.
      const first = batch()
      const upload = { ...common, connectionId: randomUUID() }
      const uploadIssued = await telemetry.issueTelemetryChallenge(
        upload,
        first.body,
      )
      assert.ok(uploadIssued.ok && uploadIssued.kind === 'challenge', kind)
      // The Connector signs at once. Both TTLs are 8 s, so only the retirement
      // below can deny this proof.
      const retired = telemetryProof(upload, uploadIssued.challenge, first.body)

      // 2. After the per-credential cooldown, WebRTC admission gets its own
      // challenge at once instead of busy until the telemetry TTL lapses.
      now += 1000
      const admission = { ...common, connectionId: randomUUID() }
      const admissionIssued = await signalling.issue(admission)
      assert.ok(
        admissionIssued.ok && admissionIssued.kind === 'challenge',
        `${kind}: admission must not wait for a pending telemetry challenge; got ${JSON.stringify(admissionIssued)}`,
      )

      // 3. The retired telemetry challenge is single-use and fails closed:
      // its signed proof is denied and commits nothing. Each step below waits
      // out the per-credential cooldown, which this change keeps.
      now += 1000
      assert.deepEqual(
        await telemetry.commitTelemetryWithProof(retired, first.body),
        { ok: false, reason: 'denied' },
      )
      assert.equal(await committedEvents(first.eventId), 0)

      // 4. Telemetry never retires a pending admission challenge.
      now += 1000
      const blocked = await telemetry.issueTelemetryChallenge(
        { ...common, connectionId: randomUUID() },
        batch().body,
      )
      assert.equal(blocked.ok, false, kind)
      assert.equal(!blocked.ok && blocked.reason, 'busy', kind)

      // 5. Another admission does not replace a pending admission either.
      now += 1000
      const other = await signalling.issue({
        ...common,
        connectionId: randomUUID(),
      })
      assert.equal(!other.ok && other.reason, 'busy', kind)

      // 6. The admission completes once and cannot be replayed.
      now += 1000
      const proof = signallingProof(admission, admissionIssued.challenge)
      const accepted = await signalling.accept(proof)
      assert.ok(accepted.ok && accepted.kind === 'accepted', kind)
      now += 1000
      assert.deepEqual(await signalling.accept(proof), {
        ok: false,
        reason: 'denied',
      })
      now += 1000
      assert.deepEqual(
        await telemetry.commitTelemetryWithProof(retired, first.body),
        { ok: false, reason: 'denied' },
      )

      // 7. The Connector resends the batch in a fresh exchange, which commits.
      now += 1000
      const resend = { ...common, connectionId: randomUUID() }
      const resendIssued = await telemetry.issueTelemetryChallenge(
        resend,
        first.body,
      )
      assert.ok(resendIssued.ok && resendIssued.kind === 'challenge', kind)
      now += 1000
      const committed = await telemetry.commitTelemetryWithProof(
        telemetryProof(resend, resendIssued.challenge, first.body),
        first.body,
      )
      assert.ok(committed.ok && committed.kind === 'telemetry-committed', kind)
      assert.deepEqual(committed.acceptedEventIds, [first.eventId])
      assert.equal(await committedEvents(first.eventId), 1)
      now += 1000
    }
  },
)

test(
  'a superseded telemetry proof never consumes cooldown reserved for the interactive proof',
  { timeout: 120_000, skip: missing || false },
  async (t) => {
    const database = disposablePostgres({
      ...vitestPostgresOptions('openfarm-fix-973r'),
      isolated: true,
    })
    t.after(() => database.stop())
    const admin = await database.start()
    const fixture = await enrol(admin)
    const pools: Sql[] = []
    t.after(() => Promise.all(pools.map((sql) => sql.end({ timeout: 3 }))))
    const password = randomBytes(24).toString('hex')
    const login = async (role: string, parent: string) => {
      await admin.unsafe(
        `CREATE ROLE ${role} LOGIN PASSWORD '${password}' IN ROLE ${parent}`,
      )
      const sql = postgres({
        host: '127.0.0.1',
        port: database.port,
        database: 'fixture',
        username: role,
        password,
        ssl: false,
        max: 2,
        connect_timeout: 3,
        onnotice: () => {},
      })
      pools.push(sql)
      return sql
    }
    let now = Date.now()
    const config = {
      issuer: ORIGIN,
      audience: AUDIENCE,
      origin: ORIGIN,
      purpose: 'signalling' as const,
      publicKeys: new Map([[KID, fixture.signer.publicKey]]),
      ttlSeconds: TTL_SECONDS,
      proofTtlMs: 8000,
    }
    const signalling = new PostgresConnectorCredentialAcceptance(
      await login('fix_973r_signalling', 'farm_connector_credential_acceptor'),
      config,
      () => now,
    )
    const telemetry = new PostgresConnectorCredentialAcceptance(
      await login('fix_973r_telemetry', 'farm_connector_telemetry_writer'),
      { ...config, purpose: 'telemetry-ingestion' },
      () => now,
    )
    const { identity } = fixture
    const committedEvents = async (eventId: string) =>
      (
        await admin`SELECT count(*)::int AS n FROM farm.telemetry_events WHERE event_id=${eventId}::uuid`
      )[0]!.n as number

    for (const [kind, token, jti] of [
      ['root', fixture.root, fixture.rootJti],
      ['successor', fixture.successor, fixture.successorJti],
    ] as const) {
      const slot = async () =>
        (kind === 'root'
          ? await admin`SELECT status,generation::float8,failures,next_attempt_at::float8,proof_version FROM farm.connector_credential_proofs WHERE jti=${jti}::uuid`
          : await admin`SELECT status,generation::float8,failures,next_attempt_at::float8,proof_version FROM farm.connector_successor_proofs WHERE jti=${jti}::uuid`)[0] as {
          status: string
          generation: number
          failures: number
          next_attempt_at: number
          proof_version: number
        }
      const common = { token, agentId: fixture.agentId, farmId: fixture.farmId }
      const eventId = randomUUID()
      const body = Buffer.from(
        JSON.stringify([
          {
            eventId,
            queuedAt: now,
            kind: 'printer-state',
            state: {
              printerKey: fixture.printerKey,
              state: 'idle',
              progress: 0,
              observedAt: now,
            },
          },
        ]),
      )

      // 1. A telemetry upload holds the slot; the Connector signs at once.
      const upload = { ...common, connectionId: randomUUID() }
      const uploadIssued = await telemetry.issueTelemetryChallenge(upload, body)
      assert.ok(uploadIssued.ok && uploadIssued.kind === 'challenge', kind)
      const superseded = {
        ...upload,
        challenge: uploadIssued.challenge,
        signature: identity.signTelemetryProof({
          challenge: uploadIssued.challenge,
          token,
          body,
          expectedOrigin: ORIGIN,
          expectedAudience: AUDIENCE,
          expectedConnectionId: upload.connectionId,
          now,
        }),
      }

      // 2. After the cooldown, WebRTC admission retires that challenge. Its
      // issuance reserves the next cooldown window for the interactive proof.
      now += 1000
      const admission = { ...common, connectionId: randomUUID() }
      const admissionIssued = await signalling.issue(admission)
      assert.ok(
        admissionIssued.ok && admissionIssued.kind === 'challenge',
        `${kind}: ${JSON.stringify(admissionIssued)}`,
      )
      const reserved = await slot()
      assert.equal(reserved.status, 'pending', kind)
      assert.equal(reserved.proof_version, 1, kind)
      assert.equal(reserved.next_attempt_at, now + 1000, kind)
      const signed = {
        ...admission,
        challenge: admissionIssued.challenge,
        signature: identity.signCredentialProof({
          challenge: admissionIssued.challenge,
          token,
          expectedOrigin: ORIGIN,
          expectedAudience: AUDIENCE,
          expectedPurpose: 'signalling',
          expectedConnectionId: admission.connectionId,
          now,
        }),
      }

      // 3. Inside that cooldown window the superseded telemetry proof is
      // denied outright (not told to wait and retry) and touches nothing.
      now += 500
      assert.deepEqual(
        await telemetry.commitTelemetryWithProof(superseded, body),
        { ok: false, reason: 'denied' },
        kind,
      )
      assert.deepEqual(await slot(), reserved, kind)

      // 4. The window opens. The superseded proof arrives first, at the same
      // instant as the interactive proof. It is denied without advancing the
      // shared cooldown, the failure counter or the pending challenge.
      now += 500
      assert.deepEqual(
        await telemetry.commitTelemetryWithProof(superseded, body),
        { ok: false, reason: 'denied' },
        kind,
      )
      assert.deepEqual(await slot(), reserved, kind)

      // 5. So the interactive proof is admitted at once, not told to wait.
      const accepted = await signalling.accept(signed)
      assert.ok(
        accepted.ok && accepted.kind === 'accepted',
        `${kind}: interactive proof must not be delayed by superseded telemetry; got ${JSON.stringify(accepted)}`,
      )
      const consumed = await slot()
      assert.equal(consumed.status, 'consumed', kind)
      assert.equal(consumed.failures, 0, kind)

      // 6. Single-use holds for both: neither proof can be replayed and the
      // superseded batch committed nothing.
      now += 1000
      assert.deepEqual(await signalling.accept(signed), {
        ok: false,
        reason: 'denied',
      })
      now += 1000
      assert.deepEqual(
        await telemetry.commitTelemetryWithProof(superseded, body),
        { ok: false, reason: 'denied' },
      )
      assert.equal(await committedEvents(eventId), 0, kind)
      now += 1000
    }
  },
)

async function enrol(admin: Sql) {
  const issuedAt = Math.floor(Date.now() / 1000)
  const account = randomUUID()
  const agentId = randomUUID()
  const farmId = randomUUID()
  const rootJti = randomUUID()
  const successorJti = randomUUID()
  const printerKey = 'contention-fixture'
  const signer = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const identity = new ConnectorIdentity(
    generateKeyPairSync('ed25519').privateKey,
  )
  const binding = await connectorKeyBinding(identity.publicKeySpki)
  const enrolledAt = (issuedAt - 5) * 1000
  await admin`INSERT INTO farm.session_accounts(id) VALUES (${account})`
  await admin`INSERT INTO farm.farms(id) VALUES (${farmId}::uuid)`
  await admin`INSERT INTO farm.account_sessions(id,account_id,account_version,created_at,last_seen_at,absolute_expires_at)
    VALUES (${account},${account},0,${enrolledAt},${enrolledAt},${enrolledAt + 3600000})`
  await admin`INSERT INTO farm.pairing_requests(agent_id,device_code_hash,user_code_hash,public_key_spki,fingerprint,platform,version,issued_at,expires_at,next_poll_at)
    VALUES (${agentId}::uuid,${randomBytes(32).toString('hex')},${randomBytes(32).toString('hex')},${identity.publicKeySpki},${binding.fingerprint},'linux','0.0.1',${enrolledAt},${enrolledAt + 900000},${enrolledAt})`
  await admin`UPDATE farm.pairing_requests SET status='approved',farm_id=${farmId}::uuid,decided_by=${account} WHERE agent_id=${agentId}::uuid`
  await admin`INSERT INTO farm.connector_enrollments(agent_id,farm_id,public_key_spki,fingerprint)
    VALUES (${agentId}::uuid,${farmId}::uuid,${identity.publicKeySpki},${binding.fingerprint})`
  await admin`UPDATE farm.connector_enrollments SET status='approved' WHERE agent_id=${agentId}::uuid`
  await admin`INSERT INTO farm.connector_credentials(jti,agent_id,farm_id,fingerprint,thumbprint,kid,issuer,audience,issued_at,expires_at)
    VALUES (${rootJti}::uuid,${agentId}::uuid,${farmId}::uuid,${binding.fingerprint},${binding.thumbprint},${KID},${ORIGIN},${AUDIENCE},${issuedAt - 2},${issuedAt - 2 + TTL_SECONDS})`
  await admin`UPDATE farm.pairing_requests SET status='consumed' WHERE agent_id=${agentId}::uuid`
  await admin`INSERT INTO farm.connector_credential_successors(jti,root_jti,predecessor_jti,ordinal,kid,issuer,audience,issued_at,expires_at)
    VALUES (${successorJti}::uuid,${rootJti}::uuid,${rootJti}::uuid,1,${KID},${ORIGIN},${AUDIENCE},${issuedAt},${issuedAt + TTL_SECONDS})`
  await admin`INSERT INTO farm.printer_assignments(id,farm_id,agent_id,printer_key,created_at,created_by)
    VALUES (${randomUUID()}::uuid,${farmId}::uuid,${agentId}::uuid,${printerKey},${enrolledAt},${account})`
  const token = (jti: string, nowSeconds: number) =>
    issueConnectorCredential({
      agentId,
      farmId,
      jti,
      nowSeconds,
      kid: KID,
      ttlSeconds: TTL_SECONDS,
      issuer: ORIGIN,
      audience: AUDIENCE,
      publicKeySpki: identity.publicKeySpki,
      privateKey: signer.privateKey,
    })
  return {
    agentId,
    farmId,
    rootJti,
    successorJti,
    printerKey,
    signer,
    identity,
    root: await token(rootJti, issuedAt - 2),
    successor: await token(successorJti, issuedAt),
  }
}
