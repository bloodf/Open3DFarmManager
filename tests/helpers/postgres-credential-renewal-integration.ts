import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID, sign, createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { appendFile, chmod, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createRenewalHttpTransport,
  renewCredentialOnce,
  writeCredentialFileAtomically,
} from '../../packages/connector/src/cloud/credential-renewal.ts'
import { readRuntimeCredential } from '../../packages/connector/src/config/credential.ts'
import { credentialLookupId } from '../../packages/connector/src/config/signalling.ts'
import { pathToFileURL } from 'node:url'
import postgres, { type Sql, type TransactionSql } from 'postgres'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import {
  PostgresPairing,
  type PairingClaim,
} from '../../apps/farm/server/storage/postgres-pairing.ts'
import { PostgresConnectorRevocation } from '../../apps/farm/server/storage/postgres-connector-revocation.ts'
import { PostgresPairingProof } from '../../apps/farm/server/storage/postgres-pairing-proof.ts'
import {
  PostgresConnectorCredentialRenewal,
  type RenewalConfig,
} from '../../apps/farm/server/storage/postgres-connector-credential-renewal.ts'
import { createCredentialRenewalHttpHandler } from '../../apps/farm/server/services/credential-renewal-http.ts'
import { createCredentialRenewalHttpRuntime } from '../../apps/farm/server/services/credential-renewal-http-runtime.ts'
import {
  RenewalRequest,
  RenewalChallenge,
  RenewalIntent,
  renewalIntentPayload,
  renewalProofPayload,
  type RenewalDecision,
} from '../../packages/farm-protocol/src/credential-renewal.ts'
import { issueConnectorCredential } from '../../apps/farm/server/utils/connector-credentials.ts'

/** Official migrations and a caller-owned disposable cluster only; all rows synthetic, no hardware. */
export async function testPostgresCredentialRenewal(
  admin: Sql,
  port: number,
  resourceJournal?: string,
): Promise<string[]> {
  const role = 'renewal_fixture_' + randomUUID().replaceAll('-', '')
  await admin`CREATE ROLE ${admin(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_connector_credential_renewer`
  const pools: Sql[] = []
  const connect = () => {
    const s = postgres({
      host: '127.0.0.1',
      port,
      database: 'fixture',
      username: role,
      password: '',
      ssl: false,
      max: 5,
      connect_timeout: 3,
    })
    pools.push(s)
    return s
  }
  const sql = connect(),
    signing = await crypto.subtle.generateKey('Ed25519', false, [
      'sign',
      'verify',
    ])
  if (!('privateKey' in signing)) throw new Error('Expected key pair')
  const config: RenewalConfig = {
    issuer: 'https://farm.example',
    audience: 'open3dfarmmanager:connector',
    origin: 'https://farm.example',
    proofAudience: 'open3dfarmmanager:renewal',
    ttlSeconds: 300,
    kid: 'fixture-key',
    publicKeys: new Map([['fixture-key', signing.publicKey]]),
    privateKeys: new Map([['fixture-key', signing.privateKey]]),
    proofTtlMs: 30000,
  }
  let now = Date.now()
  const checks: string[] = []
  const store = (pool = sql, c = config, clock = () => now) =>
    new PostgresConnectorCredentialRenewal(pool, c, clock)
  const issued = async (rootOverride?: string) => {
    const privateKey = generateKeyPairSync('ed25519').privateKey,
      identity = new ConnectorIdentity(privateKey),
      farmId = randomUUID(),
      accountId = randomUUID()
    const pairingNow = Date.now() - 100000
    await admin`INSERT INTO farm.session_accounts(id) VALUES(${accountId})`
    await admin`INSERT INTO farm.farms(id) VALUES(${farmId}::uuid)`
    await admin`INSERT INTO farm.memberships(farm_id,account_id,role) VALUES(${farmId}::uuid,${accountId},'owner')`
    await admin`INSERT INTO farm.account_sessions(id,account_id,account_version,created_at,last_seen_at,absolute_expires_at) VALUES(${accountId},${accountId},0,${pairingNow},${pairingNow},${pairingNow + 2000000})`
    const pairingConfig = {
      origin: config.origin,
      audience: 'open3dfarmmanager:pairing',
    }
    const pairing = new PostgresPairing(admin, pairingConfig, () => pairingNow),
      proofs = new PostgresPairingProof(admin, pairingConfig, () => pairingNow)
    const started = await pairing.start({
      public_key_spki: identity.publicKeySpki,
      platform: 'linux',
      version: '0.0.1',
    })
    if (!started.ok) throw new Error('Pairing start failed')
    const proof = await proofs.issue({
      device_code: started.response.device_code,
    })
    if (!proof.ok) throw new Error('Pairing proof failed')
    assert.equal(
      (
        await proofs.complete({
          device_code: started.response.device_code,
          challenge: proof.challenge,
          signature: identity.signPairingProof({
            challenge: proof.challenge,
            expectedOrigin: pairingConfig.origin,
            expectedAudience: pairingConfig.audience,
            now: pairingNow,
          }),
        })
      ).ok,
      true,
    )
    assert.equal(
      (
        await pairing.decide({
          sessionRecordId: accountId,
          policy: { idleTimeoutMs: 2000000 },
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
    const root = await (async () => {
      if (!rootOverride)
        return pairing.claim(
          { device_code: started.response.device_code },
          {
            issuer: config.issuer,
            audience: config.audience,
            kid: config.kid,
            ttlSeconds: 300,
            privateKey: signing.privateKey,
          },
        )
      const issuedAt = Math.floor(pairingNow / 1000),
        binding =
          await import('../../apps/farm/server/utils/connector-credentials.ts').then(
            (m) => m.connectorKeyBinding(identity.publicKeySpki),
          )
      const token = await issueConnectorCredential({
        issuer: config.issuer,
        audience: config.audience,
        kid: config.kid,
        ttlSeconds: 300,
        privateKey: signing.privateKey,
        nowSeconds: issuedAt,
        jti: rootOverride,
        agentId: proof.challenge.agent_id,
        farmId,
        publicKeySpki: identity.publicKeySpki,
      })
      await admin`INSERT INTO farm.connector_credentials(jti,agent_id,farm_id,fingerprint,thumbprint,kid,issuer,audience,issued_at,expires_at) VALUES(${rootOverride}::uuid,${proof.challenge.agent_id}::uuid,${farmId}::uuid,${binding.fingerprint},${binding.thumbprint},${config.kid},${config.issuer},${config.audience},${issuedAt},${issuedAt + 300})`
      await admin`UPDATE farm.pairing_requests SET status='consumed' WHERE agent_id=${proof.challenge.agent_id}::uuid`
      return {
        ok: true,
        status: 'approved',
        agent_id: proof.challenge.agent_id,
        farm_id: farmId,
        device_token: token,
        expires_at: (issuedAt + 300) * 1000,
      } satisfies Extract<PairingClaim, { status: 'approved' }>
    })()
    if (!root.ok || root.status !== 'approved')
      throw new Error('Root issuance failed')
    const metadata = (
      await admin`SELECT jti::text,expires_at::float8 FROM farm.connector_credentials WHERE agent_id=${root.agent_id}::uuid`
    )[0]
    if (!metadata) throw new Error('Missing root metadata')
    now = Date.now()
    const request = RenewalRequest.parse({
      mode: 'issue',
      identity: {
        kind: 'root',
        rootJti: metadata.jti,
        jti: metadata.jti,
        agentId: root.agent_id,
      },
      farmId,
      token: root.device_token,
    })
    return { identity, privateKey, request, root, metadata, farmId, accountId }
  }
  type Item = Awaited<ReturnType<typeof issued>>
  const completion = (
    item: Item,
    challenge: RenewalChallenge,
    request: RenewalRequest = item.request,
  ) => ({
    request,
    challenge,
    signature: sign(
      null,
      renewalProofPayload(challenge),
      item.privateKey,
    ).toString('base64url'),
  })
  const allocate = async (item: Item, s = store()) => {
    const d = await s.allocate(item.request)
    if (d.kind !== 'challenge')
      throw new Error('Expected issue challenge: ' + d.kind)
    return d.challenge
  }
  const issue = async (item: Item) => {
    const challenge = await allocate(item)
    const result = await store().complete(completion(item, challenge))
    assert.equal(result.kind, 'credential')
    if (result.kind !== 'credential')
      throw new Error('Missing issued credential')
    return { challenge, result }
  }
  const readback = (item: Item) => {
    if (item.request.mode !== 'issue') throw new Error('Missing issue identity')
    const intent = RenewalIntent.parse({
      v: 1,
      identity: item.request.identity,
      farmId: item.farmId,
      origin: config.origin,
      audience: config.proofAudience,
    })
    return RenewalRequest.parse({
      mode: 'readback',
      intent,
      identitySignature: sign(
        null,
        renewalIntentPayload(intent),
        item.privateKey,
      ).toString('base64url'),
    })
  }
  const maybeRow = async (item: Item) => {
    if (item.request.mode !== 'issue') throw new Error('Missing issue identity')
    return (
      await admin`SELECT state,reservation,challenge,parent_observed_at::float8,parent_expired_at::float8,child_observed_at::float8,child_expired_at::float8,committed_child_jti::text,result_token_sha256 FROM farm.connector_credential_renewals WHERE root_jti=${item.request.identity.rootJti}::uuid`
    )[0]
  }
  const row = async (item: Item) => {
    const value = await maybeRow(item)
    if (!value) throw new Error('Missing operation')
    return value
  }
  const freshProcess = async (value: unknown, complete: boolean) => {
    const moduleUrl = pathToFileURL(
      process.cwd() +
        '/apps/farm/server/storage/postgres-connector-credential-renewal.ts',
    ).href
    const code = `
      import postgres from 'postgres';
      import {PostgresConnectorCredentialRenewal} from ${JSON.stringify(moduleUrl)};
      let text='';for await(const chunk of process.stdin)text+=chunk;
      const input=JSON.parse(text);
      if(!/^renewal_fixture_[a-f0-9]{32}$/.test(input.role)||!Number.isInteger(input.port)||input.port<1024||input.port>65535)throw Error('Invalid own fixture');
      const sql=postgres({host:'127.0.0.1',port:input.port,database:'fixture',username:input.role,password:'',ssl:false,max:1,connect_timeout:3});
      try{
        const row=(await sql\`SELECT current_database() AS db,current_user AS actor\`)[0];
        if(row?.db!=='fixture'||row?.actor!==input.role)throw Error('Wrong own fixture');
        const key=await crypto.subtle.importKey('spki',Buffer.from(input.spki,'base64url'),'Ed25519',false,['verify']);
        const store=new PostgresConnectorCredentialRenewal(sql,{...input.config,publicKeys:new Map([[input.config.kid,key]]),privateKeys:new Map()},()=>input.now);
        const result=await (input.complete?store.complete(input.value):store.allocate(input.value));
        if(result.kind==='credential'||result.kind==='challenge')throw Error('Revived terminal operation');
        process.stdout.write(JSON.stringify({kind:result.kind}));
      }finally{await sql.end({timeout:3})}
    `
    const spki = Buffer.from(
      await crypto.subtle.exportKey('spki', signing.publicKey),
    ).toString('base64url')
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    if (resourceJournal)
      await appendFile(
        resourceJournal,
        JSON.stringify({
          kind: 'node-child',
          pid: child.pid,
          state: 'created',
        }) + '\n',
      )
    const input = {
      role,
      port,
      spki,
      now,
      value,
      complete,
      config: {
        issuer: config.issuer,
        audience: config.audience,
        origin: config.origin,
        proofAudience: config.proofAudience,
        ttlSeconds: 300,
        kid: config.kid,
        proofTtlMs: 30000,
      },
    }
    child.stdin.end(JSON.stringify(input))
    let output = '',
      errors = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      errors += chunk
    })
    const timer = setTimeout(() => child.kill('SIGTERM'), 15000)
    try {
      const exit = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', resolve)
      })
      assert.equal(exit, 0, errors)
      const result: unknown = JSON.parse(output)
      assert.ok(
        result &&
          typeof result === 'object' &&
          'kind' in result &&
          ['denied', 'expired'].includes(String(result.kind)),
      )
    } finally {
      clearTimeout(timer)
      if (resourceJournal)
        await appendFile(
          resourceJournal,
          JSON.stringify({
            kind: 'node-child',
            pid: child.pid,
            state: 'reaped',
          }) + '\n',
        )
    }
  }
  try {
    assert.ok(
      await createCredentialRenewalHttpRuntime({
        sql,
        config,
        bodyTimeoutMs: 1000,
      }),
    )
    await assert.rejects(
      createCredentialRenewalHttpRuntime({
        sql: admin,
        config,
        bodyTimeoutMs: 1000,
      }),
    )
    checks.push('dedicated leastpriv runtime accepted; admin rejected')
    const item = await issued(),
      challenge = await allocate(item)
    const reservation = challenge.reservation
    assert.deepEqual((await allocate(item)).reservation, reservation)
    const results = await Promise.all([
      store().complete(completion(item, challenge)),
      store().complete(completion(item, challenge)),
    ])
    assert.equal(results.filter((x) => x.kind === 'credential').length, 1)
    assert.equal(
      Number(
        (
          await admin`SELECT count(*)::integer AS n FROM farm.connector_credential_successors WHERE root_jti=${challenge.identity.rootJti}::uuid`
        )[0]?.n,
      ),
      1,
    )
    const result = results.find((x) => x.kind === 'credential')
    if (!result || result.kind !== 'credential')
      throw new Error('Missing result')
    assert.equal((await row(item)).state, 'COMMITTED')
    assert.equal(
      (await row(item)).result_token_sha256,
      createHash('sha256').update(result.token).digest('base64url'),
    )
    checks.push(
      'same predecessor retry/concurrent completion has one child and same immutable reservation',
    )
    // Lost result after COMMIT, repository AND pool recreation. Parent expires before child.
    now = item.metadata.expires_at * 1000 + 1000
    const fresh = store(connect()),
      request = readback(item),
      read = await fresh.allocate(request)
    assert.equal(read.kind, 'challenge')
    if (read.kind !== 'challenge') throw new Error('Missing readback')
    const reconstructed = await fresh.complete(
      completion(item, read.challenge, request),
    )
    assert.equal(reconstructed.kind, 'credential')
    if (reconstructed.kind !== 'credential')
      throw new Error('Missing reconstruction')
    assert.ok(
      reconstructed.token === result.token,
      'readback must return byte-identical JWT; bearer values redacted',
    )
    assert.equal((await row(item)).committed_child_jti, result.childJti)
    assert.equal(
      (await store().complete(completion(item, read.challenge, request))).kind,
      'denied',
    )
    checks.push(
      'lost response committed receipt with expired parent/live child returns byte-identical token with fresh PoP only',
    )
    const uncertain = await issued(),
      uncertainChallenge = await allocate(uncertain)
    // Real PostgreSQL COMMIT, then discard the driver's acknowledgement. No SQL is mocked.
    const lostAcknowledgement = new Proxy(sql, {
      get(target, key) {
        if (key === 'begin')
          return async (
            fn: (tx: TransactionSql) => Promise<RenewalDecision>,
          ) => {
            await target.begin(fn)
            throw new Error('Synthetic lost COMMIT acknowledgement')
          }
        return Reflect.get(target, key, target)
      },
    })
    assert.equal(
      (
        await store(lostAcknowledgement).complete(
          completion(uncertain, uncertainChallenge),
        )
      ).kind,
      'unavailable',
    )
    assert.equal((await row(uncertain)).state, 'COMMITTED')
    const retry = readback(uncertain),
      retryChallenge = await store(connect()).allocate(retry)
    if (retryChallenge.kind !== 'challenge')
      throw new Error('Missing ambiguous outcome reconciliation')
    const reconciled = await store().complete(
      completion(uncertain, retryChallenge.challenge, retry),
    )
    assert.equal(reconciled.kind, 'credential')
    if (reconciled.kind !== 'credential')
      throw new Error('Missing reconciled token')
    assert.equal(
      createHash('sha256').update(reconciled.token).digest('base64url'),
      (await row(uncertain)).result_token_sha256,
    )
    assert.equal(
      (
        await admin`SELECT jti FROM farm.connector_credential_successors WHERE root_jti=${uncertain.metadata.jti}::uuid`
      ).length,
      1,
    )
    checks.push(
      'real PG commit with lost driver acknowledgement is unavailable, then same receipt/readback with no second mint',
    )
    const collision = await issued(result.childJti)
    const collisionBefore = JSON.stringify(
      await admin`SELECT * FROM farm.connector_credentials WHERE jti=${result.childJti}::uuid`,
    )
    now = item.metadata.expires_at * 1000 + 1000
    const collisionRead = await store().allocate(readback(item))
    assert.equal(collisionRead.kind, 'challenge')
    if (collisionRead.kind !== 'challenge')
      throw new Error('Missing exact readback')
    assert.equal(
      (
        await store().complete(
          completion(item, collisionRead.challenge, readback(item)),
        )
      ).kind,
      'credential',
    )
    assert.equal(
      JSON.stringify(
        await admin`SELECT * FROM farm.connector_credentials WHERE jti=${result.childJti}::uuid`,
      ),
      collisionBefore,
    )
    assert.equal(await maybeRow(collision), undefined)
    checks.push(
      'cross-table identical JTI root sibling is not observed or changed by successor readback',
    )
    for (const mode of ['allocate', 'complete'])
      for (const authSample of mode === 'complete' ? [0, 16, 20] : [0, 16]) {
        const regression = authSample !== 0
        const subject = await issued()
        const proof = mode === 'complete' ? await allocate(subject) : undefined
        const E = subject.metadata.expires_at * 1000
        now = E
        let reads = 0
        // Clock.wait brackets identity verification at samples15/16, completion PoP19/20.
        const clock = () => {
          reads++
          return regression && reads >= authSample ? E - 5000 : E
        }
        const s = store(sql, config, clock)
        const decision = proof
          ? await s.complete(completion(subject, proof))
          : await s.allocate(subject.request)
        assert.notEqual(decision.kind, 'credential')
        assert.notEqual(decision.kind, 'challenge')
        const persisted = await row(subject)
        assert.equal(persisted.parent_expired_at, E)
        assert.equal(
          persisted.state,
          mode === 'allocate' ? 'OBSERVED' : 'RESERVED',
        )
        if (mode === 'allocate') assert.equal(persisted.reservation, null)
        now = E - 5000
        const recreated = store(connect())
        const again = proof
          ? await recreated.complete(completion(subject, proof))
          : await recreated.allocate(subject.request)
        assert.notEqual(again.kind, 'challenge')
        assert.notEqual(again.kind, 'credential')
        assert.equal((await row(subject)).parent_expired_at, E)
        await freshProcess(
          proof ? completion(subject, proof) : subject.request,
          Boolean(proof),
        )
        assert.equal(
          Number(
            (
              await admin`SELECT count(*)::integer AS n FROM farm.connector_credential_successors WHERE root_jti=${subject.metadata.jti}::uuid`
            )[0]?.n,
          ),
          0,
        )
        checks.push(
          `issue ${mode} entry E${regression ? ' -> backclock during auth sample ' + authSample : ''} persists terminal marker across new pool and repository with no child`,
        )
      }
    for (const mode of ['allocate', 'complete'])
      for (const authSample of mode === 'complete' ? [0, 16, 20] : [0, 16]) {
        const regression = authSample !== 0
        const subject = await issued(),
          emitted = await issue(subject),
          request = readback(subject)
        const proof =
          mode === 'complete' ? await store().allocate(request) : undefined
        if (proof && proof.kind !== 'challenge')
          throw new Error('Missing readback challenge')
        const E = emitted.result.expiresAt
        const unrelatedBefore = JSON.stringify(await row(item))
        now = E
        let reads = 0
        const s = store(sql, config, () => {
          reads++
          return regression && reads >= authSample ? E - 5000 : E
        })
        const decision =
          proof?.kind === 'challenge'
            ? await s.complete(completion(subject, proof.challenge, request))
            : await s.allocate(request)
        assert.notEqual(decision.kind, 'credential')
        assert.notEqual(decision.kind, 'challenge')
        assert.equal((await row(subject)).child_expired_at, E)
        now = E - 5000
        const recreated = store(connect())
        const again =
          proof?.kind === 'challenge'
            ? await recreated.complete(
                completion(subject, proof.challenge, request),
              )
            : await recreated.allocate(request)
        assert.notEqual(again.kind, 'credential')
        assert.notEqual(again.kind, 'challenge')
        assert.equal((await row(subject)).child_expired_at, E)
        await freshProcess(
          proof?.kind === 'challenge'
            ? completion(subject, proof.challenge, request)
            : request,
          proof?.kind === 'challenge',
        )
        assert.equal(JSON.stringify(await row(item)), unrelatedBefore)
        checks.push(
          `readback ${mode} entry E${regression ? ' -> backclock during auth sample ' + authSample : ''} terminal child retained after new pool; unrelated receipt untouched`,
        )
      }
    assert.equal(
      JSON.stringify(
        await admin`SELECT * FROM farm.connector_credentials WHERE jti=${result.childJti}::uuid`,
      ),
      collisionBefore,
    )
    assert.equal(await maybeRow(collision), undefined)
    const invalid = await issued()
    if (invalid.request.mode !== 'issue') throw new Error('Missing token')
    const parts = invalid.request.token.split('.')
    parts[2] = 'A'.repeat(86)
    now = invalid.metadata.expires_at * 1000
    assert.equal(
      (await store().allocate({ ...invalid.request, token: parts.join('.') }))
        .kind,
      'denied',
    )
    assert.equal(await maybeRow(invalid), undefined)
    const noReceipt = readback(invalid)
    assert.equal((await store().allocate(noReceipt)).kind, 'denied')
    checks.push(
      'invalid signature/expired hint creates no own observation; readback without receipt denied',
    )
    const bound = await issued()
    if (bound.request.mode !== 'issue') throw new Error('Missing root request')
    assert.equal(
      (await store().allocate({ ...bound.request, farmId: randomUUID() })).kind,
      'denied',
    )
    const changedToken = await issueConnectorCredential({
      issuer: config.issuer,
      audience: config.audience,
      ttlSeconds: 300,
      kid: config.kid,
      privateKey: signing.privateKey,
      nowSeconds: Math.floor(now / 1000) - 100,
      agentId: bound.root.agent_id,
      farmId: bound.farmId,
      publicKeySpki: bound.identity.publicKeySpki,
      jti: randomUUID(),
    })
    assert.equal(
      (await store().allocate({ ...bound.request, token: changedToken })).kind,
      'denied',
    )
    assert.equal(
      (
        await store(sql, { ...config, audience: 'foreign' }).allocate(
          bound.request,
        )
      ).kind,
      'denied',
    )
    assert.equal(await maybeRow(bound), undefined)
    checks.push(
      'signed metadata JTI/farm/audience mismatch grants no operation or authority',
    )

    const subject = await issued(),
      emitted = await issue(subject),
      req = readback(subject)
    const before = JSON.stringify(await row(subject))
    if (req.mode !== 'readback') throw new Error('Missing intent')
    assert.equal(
      (await store().allocate({ ...req, identitySignature: 'A'.repeat(86) }))
        .kind,
      'denied',
    )
    assert.equal(JSON.stringify(await row(subject)), before)
    const attempt = await store().allocate(req)
    if (attempt.kind !== 'challenge') throw new Error('Missing readback')
    assert.equal(
      (
        await store(sql, { ...config, privateKeys: new Map() }).complete(
          completion(subject, attempt.challenge, req),
        )
      ).kind,
      'recovery-required',
    )
    checks.push(
      'forged readback cannot observe child; missing original signing key returns no token',
    )
    // A different private key under the same kid must never return a reconstructed credential.
    const other = await crypto.subtle.generateKey('Ed25519', false, [
      'sign',
      'verify',
    ])
    if (!('privateKey' in other)) throw new Error('Missing key')
    assert.notEqual(
      (
        await store(sql, {
          ...config,
          privateKeys: new Map([[config.kid, other.privateKey]]),
        }).complete(completion(subject, attempt.challenge, req))
      ).kind,
      'credential',
    )
    checks.push(
      'wrong reconstruction key fails closed without changing child identity',
    )
    await assert.rejects(
      sql`UPDATE farm.connector_credential_renewals SET reservation=NULL WHERE root_jti=${subject.metadata.jti}::uuid`,
    )
    await assert.rejects(
      sql`UPDATE farm.connector_credential_renewals SET parent_expired_at=NULL,parent_observed_at=0 WHERE root_jti=${subject.metadata.jti}::uuid`,
    )
    await assert.rejects(sql`DELETE FROM farm.connector_credential_renewals`)
    await assert.rejects(sql`TRUNCATE farm.connector_credential_renewals`)
    await assert.rejects(
      sql`UPDATE farm.connector_credentials SET jti=jti WHERE jti=${subject.metadata.jti}::uuid`,
    )
    await assert.rejects(
      sql`INSERT INTO farm.connector_credential_proofs(jti) VALUES(${emitted.result.childJti}::uuid)`,
    )
    checks.push(
      'SQL null reservation/clock reset/delete/truncate/root write/A3 proof write all refused',
    )
    const revoked = await issued(),
      revokedChallenge = await allocate(revoked)
    const revoker = new PostgresConnectorRevocation(admin, () => now)
    const [revokedResult, concurrentResult] = await Promise.all([
      revoker.revoke({
        sessionRecordId: revoked.accountId,
        policy: { idleTimeoutMs: 2000000 },
        farmId: revoked.farmId,
        agentId: revoked.root.agent_id,
        expectedFingerprint: revoked.identity.fingerprint,
      }),
      store().complete(completion(revoked, revokedChallenge)),
    ])
    assert.equal(revokedResult.ok, true)
    assert.ok(['credential', 'denied'].includes(concurrentResult.kind))
    assert.equal((await store().allocate(revoked.request)).kind, 'denied')
    assert.equal((await store().allocate(readback(revoked))).kind, 'denied')
    checks.push(
      'concurrent revocation serializes enrollment; no issue/readback authority after agent tombstone',
    )
    const late = await issued(),
      lateChallenge = await allocate(late)
    const oldKeys = new Map(config.privateKeys)
    const lateKeys = new Map(config.privateKeys)
    lateKeys.get = (kid) => {
      now = late.metadata.expires_at * 1000
      return oldKeys.get(kid)
    }
    const lateResult = await store(sql, {
      ...config,
      privateKeys: lateKeys,
    }).complete(completion(late, lateChallenge))
    assert.notEqual(lateResult.kind, 'credential')
    assert.equal((await row(late)).state, 'RESERVED')
    assert.equal(
      (await row(late)).parent_expired_at,
      late.metadata.expires_at * 1000,
    )
    assert.equal(
      (
        await admin`SELECT jti FROM farm.connector_credential_successors WHERE root_jti=${late.metadata.jti}::uuid`
      ).length,
      0,
    )
    checks.push(
      'late signing savepoint rolls child/receipt back while outer terminal observation commits',
    )
    // A deferred NOTICE is delivered during COMMIT; this changes only the injected test clock.
    const delayed = await issued(),
      delayedChallenge = await allocate(delayed)
    const noticeFunction = 'renewal_commit_' + randomUUID().replaceAll('-', '')
    const trigger = noticeFunction
    await admin.unsafe(
      `CREATE FUNCTION farm.${noticeFunction}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE NOTICE 'renewal-fixture-commit'; RETURN NEW; END $$`,
    )
    await admin.unsafe(
      `CREATE CONSTRAINT TRIGGER ${trigger} AFTER UPDATE ON farm.connector_credential_renewals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.state='RESERVED' AND NEW.state='COMMITTED') EXECUTE FUNCTION farm.${noticeFunction}()`,
    )
    const noticePool = postgres({
      host: '127.0.0.1',
      port,
      database: 'fixture',
      username: role,
      password: '',
      ssl: false,
      max: 1,
      connect_timeout: 3,
      onnotice: (notice) => {
        if (notice.message === 'renewal-fixture-commit')
          now = delayed.metadata.expires_at * 1000
      },
    })
    pools.push(noticePool)
    try {
      const suppressed = await store(noticePool).complete(
        completion(delayed, delayedChallenge),
      )
      assert.notEqual(suppressed.kind, 'credential')
      assert.equal((await row(delayed)).state, 'COMMITTED')
      assert.equal(
        (await row(delayed)).parent_expired_at,
        delayed.metadata.expires_at * 1000,
      )
      const r = readback(delayed),
        challenge = await store().allocate(r)
      assert.equal(challenge.kind, 'challenge')
      if (challenge.kind !== 'challenge')
        throw new Error('Missing fresh reconciliation')
      assert.equal(
        (await store().complete(completion(delayed, challenge.challenge, r)))
          .kind,
        'credential',
      )
    } finally {
      await admin.unsafe(
        `DROP TRIGGER ${trigger} ON farm.connector_credential_renewals`,
      )
      await admin.unsafe(`DROP FUNCTION farm.${noticeFunction}()`)
    }
    checks.push(
      'COMMIT crosses parent expiry: issue response suppressed, receipt retained, fresh readback only',
    )
    const corrupt = await issued(),
      corruptChallenge = await allocate(corrupt)
    const corruptFunction = 'renewal_digest_' + randomUUID().replaceAll('-', '')
    await admin.unsafe(
      `CREATE FUNCTION farm.${corruptFunction}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='COMMITTED' AND OLD.state='RESERVED' THEN NEW.result_token_sha256:='${'A'.repeat(43)}'; END IF; RETURN NEW; END $$`,
    )
    await admin.unsafe(
      `CREATE TRIGGER z_${corruptFunction} BEFORE UPDATE ON farm.connector_credential_renewals FOR EACH ROW EXECUTE FUNCTION farm.${corruptFunction}()`,
    )
    try {
      assert.equal(
        (await store().complete(completion(corrupt, corruptChallenge))).kind,
        'credential',
      )
    } finally {
      await admin.unsafe(
        `DROP TRIGGER z_${corruptFunction} ON farm.connector_credential_renewals`,
      )
      await admin.unsafe(`DROP FUNCTION farm.${corruptFunction}()`)
    }
    const corruptRequest = readback(corrupt),
      corruptRead = await store().allocate(corruptRequest)
    if (corruptRead.kind !== 'challenge')
      throw new Error('Missing corrupted receipt readback')
    assert.equal(
      (
        await store().complete(
          completion(corrupt, corruptRead.challenge, corruptRequest),
        )
      ).kind,
      'recovery-required',
    )
    checks.push(
      'synthetic privileged receipt corruption cannot be returned through digest mismatch readback',
    )

    // Connector renewal client end to end: real HTTP handler, official store, real clock.
    const connectorClient = async (): Promise<string[]> => {
      const done: string[] = []
      const listen = async (clock: () => number) => {
        const h = createCredentialRenewalHttpHandler(
          store(sql, config, clock),
          5000,
        )
        const srv = createServer((request, response) => {
          void h({ '~app': { node: { req: request } } }).then((result) => {
            response.writeHead(result.status, {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
            })
            response.end(JSON.stringify(result.body))
          })
        })
        await new Promise<void>((resolve, reject) => {
          srv.once('error', reject)
          srv.listen(0, '127.0.0.1', () => resolve())
        })
        const address = srv.address()
        if (!address || typeof address === 'string')
          throw new Error('Missing loopback port')
        return {
          transport: createRenewalHttpTransport({
            origin: `http://127.0.0.1:${address.port}`,
            timeoutMs: 5000,
            allowLoopbackHttpForTests: true,
          }),
          close: () =>
            new Promise<void>((resolve, reject) =>
              srv.close((error) => (error ? reject(error) : resolve())),
            ),
        }
      }
      const directory = await mkdtemp(join(tmpdir(), 'o3dfm-renewal-client-'))
      await chmod(directory, 0o700)
      const live = await listen(Date.now)
      const late = await listen(() => Date.now() + 10_000_000)
      try {
        const item = await issued()
        const credentialPath = join(directory, 'credential.json')
        writeCredentialFileAtomically(credentialPath, {
          version: 1,
          expected_fingerprint: item.identity.fingerprint,
          approval: {
            status: 'approved',
            agent_id: item.root.agent_id,
            farm_id: item.farmId,
            device_token: item.root.device_token,
            expires_at: item.root.expires_at,
          },
        })
        const current = () =>
          readRuntimeCredential(
            credentialPath,
            item.identity.fingerprint,
            Date.now(),
          )
        const once = (transport = live.transport) =>
          renewCredentialOnce({
            credentialPath,
            credential: current(),
            identity: item.identity,
            transport,
            origin: config.origin,
            audience: config.proofAudience,
            signal: AbortSignal.timeout(20000),
            now: Date.now,
          })
        const successors = async () =>
          (
            await admin`SELECT jti::text,ordinal FROM farm.connector_credential_successors WHERE root_jti=${item.metadata.jti}::uuid ORDER BY ordinal`
          ).map((r) => ({ jti: r.jti as string, ordinal: r.ordinal as number }))

        const root = current()
        assert.equal((await once()).kind, 'renewed')
        const first = current()
        assert.equal(first.root_jti, item.metadata.jti)
        assert.deepEqual(await successors(), [
          { jti: credentialLookupId(first.device_token), ordinal: 1 },
        ])
        assert.equal((await stat(credentialPath)).mode & 0o777, 0o600)
        assert.equal(first.device_token === root.device_token, false)
        done.push(
          'connector client renewed root over real HTTP and persisted the committed successor privately',
        )

        // Successor expiry must strictly exceed the parent's (1 s claim resolution).
        await new Promise((resolve) => setTimeout(resolve, 1100))
        assert.equal((await once()).kind, 'renewed')
        const second = current()
        assert.deepEqual((await successors()).at(-1), {
          jti: credentialLookupId(second.device_token),
          ordinal: 2,
        })
        done.push('connector client renewed a successor as kind successor')

        // Commit succeeds server-side, local write cannot: the old credential stays.
        await new Promise((resolve) => setTimeout(resolve, 1100))
        await chmod(directory, 0o500)
        await assert.rejects(once())
        await chmod(directory, 0o700)
        assert.deepEqual(current(), second)
        const committed = (await successors()).at(-1)
        assert.equal(committed?.ordinal, 3)
        assert.equal((await once()).kind, 'renewed')
        const recovered = current()
        assert.equal(credentialLookupId(recovered.device_token), committed?.jti)
        assert.equal((await successors()).length, 3)
        assert.equal(
          (
            await admin`SELECT result_token_sha256 FROM farm.connector_credential_renewals WHERE predecessor_jti=${credentialLookupId(second.device_token)}::uuid`
          )[0]?.result_token_sha256,
          createHash('sha256')
            .update(recovered.device_token)
            .digest('base64url'),
        )
        assert.deepEqual(await readdir(directory), ['credential.json'])
        done.push(
          'connector crash between server commit and local write recovered the same successor by readback',
        )

        // Server clock past hard expiry: denial, no successor, credential untouched.
        assert.deepEqual(await once(late.transport), {
          kind: 'retry',
          reason: 'challenge-403',
        })
        assert.deepEqual(current(), recovered)
        assert.equal((await successors()).length, 3)
        done.push(
          'connector client fails closed when the predecessor is expired at the server',
        )
      } finally {
        await chmod(directory, 0o700)
        await rm(directory, { recursive: true, force: true })
        await live.close()
        await late.close()
      }
      return done
    }

    // Real HTTP transport boundary, not a stand-in store or SQL string mock.
    const httpItem = await issued(),
      handler = createCredentialRenewalHttpHandler(store(), 1000)
    const server = createServer((request, response) => {
      void handler({ '~app': { node: { req: request } } }).then((result) => {
        response.writeHead(result.status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        })
        response.end(JSON.stringify(result.body))
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    try {
      const address = server.address()
      if (!address || typeof address === 'string')
        throw new Error('Missing loopback port')
      const base = `http://127.0.0.1:${address.port}/api/connector/credentials/renewal/`
      const response = await fetch(base + 'challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(httpItem.request),
      })
      assert.equal(response.status, 200)
      const body: unknown = await response.json()
      if (!body || typeof body !== 'object' || !('challenge' in body))
        throw new Error('Missing HTTP challenge')
      const proof = RenewalChallenge.parse(body.challenge)
      const delivered = await fetch(base + 'complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(completion(httpItem, proof)),
      })
      assert.equal(delivered.status, 200)
      await delivered.body?.cancel()
      now = httpItem.metadata.expires_at * 1000 + 1000
      const lostRequest = readback(httpItem)
      const recoveredChallenge = await fetch(base + 'challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(lostRequest),
      })
      assert.equal(recoveredChallenge.status, 200)
      const readBody: unknown = await recoveredChallenge.json()
      if (
        !readBody ||
        typeof readBody !== 'object' ||
        !('challenge' in readBody)
      )
        throw new Error('Missing reconciliation challenge')
      const readChallenge = RenewalChallenge.parse(readBody.challenge)
      const recovered = await fetch(base + 'complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(completion(httpItem, readChallenge, lostRequest)),
      })
      assert.equal(recovered.status, 200)
      await recovered.body?.cancel()

      const denied = await fetch(base + 'challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: 'foreign=1' },
        body: JSON.stringify(httpItem.request),
      })
      assert.equal(denied.status, 400)
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
    checks.push(
      'real loopback HTTP challenge/complete handler writes official store; foreign cookie refused; server closed',
    )
    checks.push(...(await connectorClient()))
    return checks
  } finally {
    for (const pool of pools) await pool.end({ timeout: 3 })
    await admin`DROP ROLE ${admin(role)}`
  }
}
