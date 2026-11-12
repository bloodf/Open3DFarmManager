// Signalling with renewed (successor) Connector credentials, on a caller-owned
// disposable cluster migrated through 0026. A real Connector client renews over
// the real renewal HTTP handler; the real signalling reader and signalling proof
// acceptor then run under least-privilege login roles. All rows synthetic.
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import postgres, { type Sql } from 'postgres'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import {
  createRenewalHttpTransport,
  renewCredentialOnce,
  writeCredentialFileAtomically,
} from '../../packages/connector/src/cloud/credential-renewal.ts'
import { readRuntimeCredential } from '../../packages/connector/src/config/credential.ts'
import { credentialLookupId } from '../../packages/connector/src/config/signalling.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import { PostgresPairing } from '../../apps/farm/server/storage/postgres-pairing.ts'
import { PostgresPairingProof } from '../../apps/farm/server/storage/postgres-pairing-proof.ts'
import { PostgresPrinterOwnership } from '../../apps/farm/server/storage/postgres-printer-ownership.ts'
import { PostgresConnectorRevocation } from '../../apps/farm/server/storage/postgres-connector-revocation.ts'
import { PostgresConnectorCredentialRenewal } from '../../apps/farm/server/storage/postgres-connector-credential-renewal.ts'
import { PostgresConnectorCredentialAcceptance } from '../../apps/farm/server/storage/postgres-connector-credential-acceptance.ts'
import {
  PostgresSignallingAuthorization,
  SIGNALLING_IDLE_TIMEOUT_MS,
} from '../../apps/farm/server/storage/postgres-signalling-authorization.ts'
import { createCredentialRenewalHttpHandler } from '../../apps/farm/server/services/credential-renewal-http.ts'

const ORIGIN = 'https://farm.example'
const AUDIENCE = 'open3dfarmmanager:connector'
const PROOF_AUDIENCE = 'open3dfarmmanager:renewal'
const KID = 'successor-fixture'
const TTL = 20
const policy = { idleTimeoutMs: SIGNALLING_IDLE_TIMEOUT_MS }
const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))

export async function testPostgresSignallingSuccessors(
  admin: Sql,
  port: number,
): Promise<string[]> {
  const checks: string[] = []
  const outcomes: string[] = []
  const suffix = randomUUID().replaceAll('-', '')
  const logins = {
    reader: 'successor_reader_' + suffix,
    acceptor: 'successor_acceptor_' + suffix,
    renewer: 'successor_renewer_' + suffix,
  }
  const parents = {
    reader: 'farm_signalling_reader',
    acceptor: 'farm_connector_credential_acceptor',
    renewer: 'farm_connector_credential_renewer',
  } as const
  const pools: Sql[] = []
  const pool = (username: string) => {
    const sql = postgres({
      host: '127.0.0.1',
      port,
      database: 'fixture',
      username,
      password: '',
      ssl: false,
      max: 4,
      connect_timeout: 3,
    })
    pools.push(sql)
    return sql
  }
  const created: string[] = []
  const directory = await mkdtemp(join(tmpdir(), 'o3dfm-signalling-successor-'))
  await chmod(directory, 0o700)
  let server: ReturnType<typeof createServer> | undefined
  try {
    for (const [name, login] of Object.entries(logins)) {
      await admin`CREATE ROLE ${admin(login)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE ${admin(parents[name as keyof typeof parents])}`
      created.push(login)
    }

    // Exact 0026 grants on the successor tables (plus the 0022 writer grants).
    const tableGrants = (
      await admin`SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants WHERE table_schema='farm' AND table_name IN ('connector_credential_successors','connector_successor_proofs') AND grantee IN ('farm_signalling_reader','farm_connector_credential_acceptor') ORDER BY 1,2,3`
    ).map((row) => `${row.grantee}:${row.table_name}:${row.privilege_type}`)
    assert.deepEqual(tableGrants, [
      'farm_connector_credential_acceptor:connector_credential_successors:SELECT',
      'farm_connector_credential_acceptor:connector_successor_proofs:INSERT',
      'farm_connector_credential_acceptor:connector_successor_proofs:SELECT',
      'farm_signalling_reader:connector_credential_successors:SELECT',
    ])
    const columnGrants = (
      await admin`SELECT grantee, table_name, column_name FROM information_schema.column_privileges WHERE table_schema='farm' AND table_name IN ('connector_credential_successors','connector_successor_proofs') AND privilege_type='UPDATE' AND grantee IN ('farm_signalling_reader','farm_connector_credential_acceptor') ORDER BY 1,2,3`
    ).map((row) => `${row.grantee}:${row.table_name}:${row.column_name}`)
    assert.deepEqual(
      columnGrants,
      [
        'farm_connector_credential_acceptor:connector_credential_successors:jti',
        ...[
          'body_bytes',
          'body_sha256',
          'consumed_at',
          'credential_expired_at',
          'expires_at',
          'failures',
          'generation',
          'issued_at',
          'next_attempt_at',
          'nonce',
          'observed_at',
          'operation_method',
          'operation_path',
          'origin',
          'proof_version',
          'purpose',
          'status',
          'token_hash',
          'audience',
          'connection_id',
        ]
          .sort()
          .map(
            (column) =>
              `farm_connector_credential_acceptor:connector_successor_proofs:${column}`,
          ),
      ].sort(),
    )
    const readerSql = pool(logins.reader)
    for (const query of [
      readerSql`SELECT jti FROM farm.connector_successor_proofs LIMIT 1`,
      readerSql`UPDATE farm.connector_credential_successors SET jti=jti WHERE false`,
      readerSql`SELECT jti FROM farm.connector_credential_successors FOR SHARE`,
    ])
      await assert.rejects(query, /permission denied/)
    checks.push(
      '0026 grants are exact: reader SELECT on successors only; acceptor mirrors the 0022 writer grants',
    )

    // Real signing key shared by pairing claims and renewal.
    const signing = (await crypto.subtle.generateKey('Ed25519', false, [
      'sign',
      'verify',
    ])) as CryptoKeyPair
    const reader = new PostgresSignallingAuthorization(readerSql, {
      issuer: ORIGIN,
      origin: ORIGIN,
      audience: AUDIENCE,
      idleTimeoutMs: SIGNALLING_IDLE_TIMEOUT_MS,
    })
    const acceptor = new PostgresConnectorCredentialAcceptance(
      pool(logins.acceptor),
      {
        issuer: ORIGIN,
        audience: AUDIENCE,
        origin: ORIGIN,
        purpose: 'signalling',
        publicKeys: new Map([[KID, signing.publicKey]]),
        ttlSeconds: TTL,
        proofTtlMs: 30000,
      },
    )
    const renewal = new PostgresConnectorCredentialRenewal(
      pool(logins.renewer),
      {
        issuer: ORIGIN,
        audience: AUDIENCE,
        origin: ORIGIN,
        proofAudience: PROOF_AUDIENCE,
        ttlSeconds: TTL,
        kid: KID,
        publicKeys: new Map([[KID, signing.publicKey]]),
        privateKeys: new Map([[KID, signing.privateKey]]),
        proofTtlMs: 30000,
      },
    )
    const handler = createCredentialRenewalHttpHandler(renewal, 5000)
    server = createServer((request, response) => {
      void handler({ '~app': { node: { req: request } } }).then((result) => {
        response.writeHead(result.status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        })
        response.end(JSON.stringify(result.body))
      })
    })
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('Missing loopback port')
    const transport = createRenewalHttpTransport({
      origin: `http://127.0.0.1:${address.port}`,
      timeoutMs: 5000,
      allowLoopbackHttpForTests: true,
    })

    // One paired, assigned Connector with an approved browser key in its own farm.
    async function connector(name: string) {
      const now = Date.now()
      const accountId = randomUUID(),
        farmId = randomUUID()
      await admin`INSERT INTO farm.session_accounts(id) VALUES(${accountId})`
      await admin`INSERT INTO farm.account_sessions(id,account_id,account_version,created_at,last_seen_at,absolute_expires_at) VALUES(${accountId},${accountId},0,${now - 2000},${now - 1000},${now + 3600000})`
      await admin`INSERT INTO farm.farms(id) VALUES(${farmId}::uuid)`
      await admin`INSERT INTO farm.memberships(farm_id,account_id,role) VALUES(${farmId}::uuid,${accountId},'owner')`
      const identity = new ConnectorIdentity(
        generateKeyPairSync('ed25519').privateKey,
      )
      const pairingConfig = {
        origin: ORIGIN,
        audience: 'open3dfarmmanager:pairing',
      }
      const pairing = new PostgresPairing(admin, pairingConfig)
      const proof = new PostgresPairingProof(admin, pairingConfig)
      const started = await pairing.start({
        public_key_spki: identity.publicKeySpki,
        platform: 'linux',
        version: '0.0.1',
      })
      assert.ok(started.ok)
      const challenge = await proof.issue({
        device_code: started.response.device_code,
      })
      assert.ok(challenge.ok)
      assert.ok(
        (
          await proof.complete({
            device_code: started.response.device_code,
            challenge: challenge.challenge,
            signature: identity.signPairingProof({
              challenge: challenge.challenge,
              expectedOrigin: pairingConfig.origin,
              expectedAudience: pairingConfig.audience,
              now: Date.now(),
            }),
          })
        ).ok,
      )
      assert.ok(
        (
          await pairing.decide({
            sessionRecordId: accountId,
            policy,
            decision: 'approve',
            request: {
              user_code: started.response.user_code,
              farm_id: farmId,
              expected_fingerprint: identity.fingerprint,
            },
          })
        ).ok,
      )
      const claim = await pairing.claim(
        { device_code: started.response.device_code },
        {
          issuer: ORIGIN,
          audience: AUDIENCE,
          kid: KID,
          privateKey: signing.privateKey,
          ttlSeconds: TTL,
        },
      )
      assert.ok(claim.ok && claim.status === 'approved')
      const agentId = claim.agent_id
      const browser = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign', 'verify'],
      )
      const jwk = await crypto.subtle.exportKey('jwk', browser.publicKey)
      const key = await validateBrowserDevicePublicKey({
        kty: jwk.kty,
        crv: jwk.crv,
        x: jwk.x,
        y: jwk.y,
      })
      const keyId = randomUUID(),
        keyAt = Date.now()
      await admin`INSERT INTO farm.browser_device_keys(key_id,farm_id,account_id,public_key,thumbprint,created_at) VALUES(${keyId}::uuid,${farmId}::uuid,${accountId},${admin.json(key.publicKey)},${key.thumbprint},${keyAt})`
      await admin`UPDATE farm.browser_device_keys SET proof_at=${keyAt},proof_session_id=${accountId},status='approved',approved_at=${keyAt},approved_by=${accountId} WHERE key_id=${keyId}::uuid`
      const scope = { sessionRecordId: accountId, farmId, agentId, keyId }
      const assigned = await new PostgresPrinterOwnership(admin).register({
        ...scope,
        policy,
        printerKey: name + '-printer',
      })
      assert.ok(assigned.ok)
      const credentialPath = join(directory, name + '.json')
      writeCredentialFileAtomically(credentialPath, {
        version: 1,
        expected_fingerprint: identity.fingerprint,
        approval: {
          status: 'approved',
          agent_id: agentId,
          farm_id: farmId,
          device_token: claim.device_token,
          expires_at: claim.expires_at,
        },
      })
      const current = () =>
        readRuntimeCredential(credentialPath, identity.fingerprint, Date.now())
      return {
        identity,
        scope,
        agentId,
        farmId,
        root: {
          token: claim.device_token,
          jti: credentialLookupId(claim.device_token),
          expiresAt: claim.expires_at,
        },
        /** Renews through the real client and HTTP handler; returns the new token. */
        async renew() {
          const outcome = await renewCredentialOnce({
            credentialPath,
            credential: current(),
            identity,
            transport,
            origin: ORIGIN,
            audience: PROOF_AUDIENCE,
            signal: AbortSignal.timeout(20000),
            now: Date.now,
          })
          assert.equal(outcome.kind, 'renewed')
          const renewed = current()
          return {
            token: renewed.device_token,
            jti: credentialLookupId(renewed.device_token),
            expiresAt: renewed.expires_at,
          }
        },
      }
    }
    type Fixture = Awaited<ReturnType<typeof connector>>
    const current = (fixture: Fixture, jti: string, farmId = fixture.farmId) =>
      reader.readConnectorCurrent({ agentId: fixture.agentId, farmId, jti })
    /** Full signalling proof (issue + signed completion) for one token. */
    async function prove(
      fixture: Fixture,
      token: string,
      scope = { agentId: fixture.agentId, farmId: fixture.farmId },
    ) {
      const request = { token, ...scope, connectionId: randomUUID() }
      const issued = await acceptor.issue(request)
      if (!issued.ok || issued.kind !== 'challenge') return issued
      return acceptor.accept({
        ...request,
        challenge: issued.challenge,
        signature: fixture.identity.signCredentialProof({
          challenge: issued.challenge,
          token,
          expectedOrigin: ORIGIN,
          expectedAudience: AUDIENCE,
          expectedPurpose: 'signalling',
          expectedConnectionId: request.connectionId,
          now: Date.now(),
        }),
      })
    }
    const acceptedJti = (result: Awaited<ReturnType<typeof prove>>) => {
      // Reasons only (no tokens), kept for a failing assertion's context.
      outcomes.push(result.ok ? result.kind : result.reason)
      return result.ok && result.kind === 'accepted' ? result.jti : null
    }

    const a = await connector('a')
    const b = await connector('b')
    // Before renewal the root is the only and current credential.
    assert.equal(
      (await current(a, a.root.jti))?.identity.credential_jti,
      a.root.jti,
    )
    const rootAuthority = await reader.authorize(a.scope)
    assert.ok(rootAuthority.ok)
    assert.equal(rootAuthority.authority.credential_jti, a.root.jti)
    assert.equal(acceptedJti(await prove(a, a.root.token)), a.root.jti)
    checks.push('root credential accepted before renewal (unchanged path)')

    // A successor must be issued in a later second than its parent.
    await sleep(1100)
    const first = await a.renew()
    assert.notEqual(first.jti, a.root.jti)
    const firstCurrent = await current(a, first.jti)
    assert.equal(firstCurrent?.identity.credential_jti, first.jti)
    assert.equal(firstCurrent?.identity.validUntil, first.expiresAt)
    const firstAuthority = await reader.authorize(a.scope)
    assert.ok(firstAuthority.ok)
    assert.equal(firstAuthority.authority.credential_jti, first.jti)
    assert.equal(acceptedJti(await prove(a, first.token)), first.jti)
    assert.equal(
      (
        await admin`SELECT purpose, status FROM farm.connector_successor_proofs WHERE jti=${first.jti}::uuid`
      )[0]?.status,
      'consumed',
    )
    // #132 semantics: renewal does not revoke the still-valid predecessor.
    assert.equal(
      (await current(a, a.root.jti))?.identity.credential_jti,
      a.root.jti,
    )
    assert.equal(acceptedJti(await prove(a, a.root.token)), a.root.jti)
    checks.push(
      '(a) renewed successor: reader resolves it, browser authority selects it, signalling proof accepts it; predecessor still valid until its expiry',
    )

    // Spaced so the second successor outlives its predecessors by several seconds.
    await sleep(6000)
    const second = await a.renew()
    assert.equal(
      (await current(a, second.jti))?.identity.credential_jti,
      second.jti,
    )
    const secondAuthority = await reader.authorize(a.scope)
    assert.ok(secondAuthority.ok)
    assert.equal(secondAuthority.authority.credential_jti, second.jti)
    assert.equal(acceptedJti(await prove(a, second.token)), second.jti)
    checks.push(
      'second-generation successor accepted; browser authority follows the newest valid credential',
    )

    // (d) Another Connector's successor never authorizes this one, in any farm.
    await sleep(1100)
    const other = await b.renew()
    assert.equal(acceptedJti(await prove(b, other.token)), other.jti)
    assert.equal(await current(a, other.jti), null)
    assert.equal(
      await reader.readConnectorCurrent({
        agentId: b.agentId,
        farmId: a.farmId,
        jti: other.jti,
      }),
      null,
    )
    assert.equal(await current(a, first.jti, b.farmId), null)
    assert.equal(acceptedJti(await prove(a, other.token)), null)
    assert.equal(
      acceptedJti(
        await prove(b, other.token, { agentId: a.agentId, farmId: a.farmId }),
      ),
      null,
    )
    assert.equal(
      acceptedJti(
        await prove(a, first.token, { agentId: a.agentId, farmId: b.farmId }),
      ),
      null,
    )
    checks.push(
      '(d) a successor of another Connector or farm is refused by reader and acceptor',
    )

    // (b) Each predecessor is refused once its own expiry passes.
    await sleep(Math.max(a.root.expiresAt, first.expiresAt) + 1500 - Date.now())
    assert.ok(Date.now() < second.expiresAt - 1500, 'fixture timing margin')
    assert.equal(await current(a, a.root.jti), null)
    assert.equal(await current(a, first.jti), null)
    assert.equal(acceptedJti(await prove(a, a.root.token)), null)
    assert.equal(acceptedJti(await prove(a, first.token)), null)
    assert.equal(
      (await current(a, second.jti))?.identity.credential_jti,
      second.jti,
    )
    assert.equal(acceptedJti(await prove(a, second.token)), second.jti)
    const laterAuthority = await reader.authorize(a.scope)
    assert.ok(laterAuthority.ok)
    assert.equal(laterAuthority.authority.credential_jti, second.jti)
    checks.push(
      '(b) root and first successor refused after their own expiry; the live successor stays accepted',
    )

    // (c) Revoking the Connector refuses the whole chain.
    const revoked = await new PostgresConnectorRevocation(admin).revoke({
      sessionRecordId: a.scope.sessionRecordId,
      policy,
      farmId: a.farmId,
      agentId: a.agentId,
      expectedFingerprint: a.identity.fingerprint,
    })
    assert.ok(revoked.ok)
    assert.equal(await current(a, second.jti), null)
    assert.deepEqual(await reader.authorize(a.scope), {
      ok: false,
      reason: 'denied',
    })
    assert.equal(acceptedJti(await prove(a, second.token)), null)
    // The unrelated Connector is unaffected.
    assert.equal(acceptedJti(await prove(b, other.token)), other.jti)
    checks.push(
      '(c) revoked Connector: the live successor is refused by reader, browser authority and acceptor; others unaffected',
    )
    return checks
  } catch (error) {
    throw new Error(
      'Signalling successor check failed; proof outcomes: ' +
        outcomes.join(','),
      { cause: error },
    )
  } finally {
    if (server)
      await new Promise<void>((resolve) => server!.close(() => resolve()))
    for (const sql of pools) await sql.end({ timeout: 3 })
    for (const login of created) await admin`DROP ROLE ${admin(login)}`
    await rm(directory, { recursive: true, force: true })
  }
}
