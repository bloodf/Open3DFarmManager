import assert from 'node:assert/strict'
import { randomUUID, randomBytes } from 'node:crypto'
import postgres, { type Sql, type TransactionSql } from 'postgres'
import {
  catalogThrough,
  loadMigrationCatalog,
  runMigrations,
} from '../../scripts/db/migrations.ts'
import {
  readAcceptanceCredentialRecords,
  readSignallingCredentialRecords,
  readPauseNegotiationCredentialRecords,
  readPauseAuthorityCredentialRecords,
  readRevocationCredentialRecords,
} from '../../apps/farm/server/storage/postgres-connector-credential-record.ts'
import { validatePauseAuthorityRole } from '../../apps/farm/server/utils/pause-authority/role-policy.ts'

/** Only the runner's fresh, dedicated container may supply this database. */
export async function testPostgresCredentialSuccessors(
  admin: Sql,
  port: number,
) {
  const catalog = catalogThrough(
    await loadMigrationCatalog(),
    '0021_connector_credential_successors',
  )
  assert.equal(catalog.at(-1)?.id, '0021_connector_credential_successors')
  assert.equal((await admin`SELECT current_database() AS db`)[0]?.db, 'fixture')
  assert.equal(
    (await admin`SELECT to_regnamespace('farm') AS schema`)[0]?.schema,
    null,
  )
  await runMigrations(admin, catalog.slice(0, 20), { kind: 'up' })
  const now = Number(
    (
      await admin`SELECT floor(extract(epoch FROM clock_timestamp()))::float8 AS n`
    )[0]?.n,
  )
  const digest = 'A'.repeat(43)
  const account = randomUUID()
  await admin`INSERT INTO farm.session_accounts(id) VALUES(${account})`
  await admin`INSERT INTO farm.account_sessions(id,account_id,account_version,created_at,last_seen_at,absolute_expires_at) VALUES(${account},${account},0,${now * 1000},${now * 1000},${(now + 3600) * 1000})`
  // Synthetic metadata through the real lifecycle triggers; no physical device,
  // JWT issuance, signature acceptance or production authority is exercised.
  async function root(issued = now - 10, expires = now + 600) {
    const agent = randomUUID(),
      farm = randomUUID(),
      jti = randomUUID()
    await admin`INSERT INTO farm.farms(id) VALUES(${farm}::uuid)`
    await admin`INSERT INTO farm.pairing_requests(agent_id,device_code_hash,user_code_hash,public_key_spki,fingerprint,platform,version,issued_at,expires_at,next_poll_at)
      VALUES(${agent}::uuid,${randomBytes(32).toString('hex')},${randomBytes(32).toString('hex')},${'A'.repeat(59)},${'SHA256:' + digest},'linux','0.0.1',${issued * 1000},${issued * 1000 + 900000},${issued * 1000})`
    await admin`UPDATE farm.pairing_requests SET status='approved',farm_id=${farm}::uuid,decided_by=${account} WHERE agent_id=${agent}::uuid`
    await admin`INSERT INTO farm.connector_enrollments(agent_id,farm_id,public_key_spki,fingerprint) VALUES(${agent}::uuid,${farm}::uuid,${'A'.repeat(59)},${'SHA256:' + digest})`
    await admin`UPDATE farm.connector_enrollments SET status='approved' WHERE agent_id=${agent}::uuid`
    await admin`INSERT INTO farm.connector_credentials(jti,agent_id,farm_id,fingerprint,thumbprint,kid,issuer,audience,issued_at,expires_at)
      VALUES(${jti}::uuid,${agent}::uuid,${farm}::uuid,${'SHA256:' + digest},${digest},'test-key','https://farm.example','connector',${issued},${expires})`
    await admin`UPDATE farm.pairing_requests SET status='consumed' WHERE agent_id=${agent}::uuid`
    return { agent, farm, jti }
  }
  const first = await root()
  await admin`INSERT INTO farm.connector_credential_proofs(jti,observed_at,next_attempt_at) VALUES(${first.jti}::uuid,${now * 1000},${now * 1000})`
  const key = randomUUID(),
    assignment = randomUUID()
  await admin`INSERT INTO farm.browser_device_keys(key_id,farm_id,account_id,public_key,thumbprint,created_at) VALUES(${key}::uuid,${first.farm}::uuid,${account},${admin.json({ kty: 'EC', crv: 'P-256', x: digest, y: digest })},${digest},${now * 1000})`
  await admin`INSERT INTO farm.printer_assignments(id,farm_id,agent_id,printer_key,created_at,created_by) VALUES(${assignment}::uuid,${first.farm}::uuid,${first.agent}::uuid,'fixture',${now * 1000},${account})`
  async function pause(jti: string) {
    return admin`INSERT INTO farm.pause_authority_challenges(challenge_id,session_id,account_id,farm_id,agent_id,key_id,credential_jti,assignment_id,transport_id,admission_nonce,binding,challenge,issued_at,expires_at,binding_expires_at,credential_expires_at)
      VALUES(${randomUUID()}::uuid,${account},${account},${first.farm}::uuid,${first.agent}::uuid,${key}::uuid,${jti}::uuid,${assignment}::uuid,${randomUUID()}::uuid,${randomBytes(32).toString('base64url')},${admin.json({ credential_jti: jti, signed_bytes: 'fixture-unaltered-雪' })},${admin.json({ purpose: 'fixture-only', bytes: 'literal-preserved' })},${now * 1000},${now * 1000 + 8000},${now * 1000 + 9000},${(now + 600) * 1000})`
  }
  await pause(first.jti)
  const snapshot = async () => ({
    roots: [
      ...(await admin`SELECT * FROM farm.connector_credentials ORDER BY jti`),
    ],
    proofs: [
      ...(await admin`SELECT * FROM farm.connector_credential_proofs ORDER BY jti`),
    ],
    pause: [
      ...(await admin`SELECT *,binding::text AS binding_bytes,challenge::text AS challenge_bytes FROM farm.pause_authority_challenges ORDER BY challenge_id`),
    ],
  })
  const before = await snapshot()
  await runMigrations(admin, catalog, { kind: 'up' })
  assert.deepEqual(await snapshot(), before)
  const down = () =>
    runMigrations(admin, catalog, {
      kind: 'down',
      expectedLastId: '0021_connector_credential_successors',
    })
  // A dependent object must block even empty down; the failed DDL rolls back.
  await admin`CREATE VIEW public.successor_dependency AS SELECT jti FROM farm.connector_credential_successors`
  await assert.rejects(down(), { code: '2BP01' })
  await admin`DROP VIEW public.successor_dependency`
  await down()
  assert.equal(
    (
      await admin`SELECT to_regclass('farm.connector_credential_successors') AS name`
    )[0]?.name,
    null,
  )
  assert.deepEqual(await snapshot(), before)
  await runMigrations(admin, catalog, { kind: 'up' })

  type Row = {
    jti: string
    root_jti: string
    predecessor_jti: string
    predecessor_successor_jti: string | null
    ordinal: number
    kid: string
    issuer: string
    audience: string
    issued_at: number
    expires_at: number
  }
  function row(rootJti: string, changes: Partial<Row> = {}): Row {
    return {
      jti: randomUUID(),
      root_jti: rootJti,
      predecessor_jti: rootJti,
      predecessor_successor_jti: null,
      ordinal: 1,
      kid: 'test-key-2',
      issuer: 'https://farm.example',
      audience: 'connector',
      issued_at: now,
      expires_at: now + 1200,
      ...changes,
    }
  }
  const insert = (tx: Sql | TransactionSql, value: Row) =>
    tx`INSERT INTO farm.connector_credential_successors ${tx(value)}`
  const successor = row(first.jti)
  await insert(admin, successor)
  const second = row(first.jti, {
    predecessor_jti: successor.jti,
    predecessor_successor_jti: successor.jti,
    ordinal: 2,
  })
  await insert(admin, second)
  assert.deepEqual(
    [
      ...(await admin`SELECT jti,root_jti,predecessor_jti,ordinal FROM farm.connector_credential_successors ORDER BY ordinal`),
    ],
    [successor, second].map(({ jti, root_jti, predecessor_jti, ordinal }) => ({
      jti,
      root_jti,
      predecessor_jti,
      ordinal,
    })),
  )
  const checks = [
    'expand-preserves-root-proof-and-pause-bytes',
    'empty-down-and-dependent-object-refusal',
    'first-and-second-successor',
  ]
  const spare = await root()
  const invalid = [
    row(spare.jti, { jti: spare.jti }),
    row(spare.jti, { jti: first.jti }),
    row(spare.jti, { root_jti: randomUUID() }),
    row(spare.jti, { ordinal: 0 }),
    row(spare.jti, { ordinal: 2 }),
    row(spare.jti, { predecessor_jti: randomUUID() }),
    row(spare.jti, { predecessor_successor_jti: successor.jti }),
    row(spare.jti, {
      predecessor_jti: successor.jti,
      predecessor_successor_jti: successor.jti,
      ordinal: 2,
    }),
    row(first.jti, {
      predecessor_jti: second.jti,
      predecessor_successor_jti: second.jti,
      ordinal: 4,
    }),
    row(spare.jti, { kid: 'bad key' }),
    row(spare.jti, { issuer: 'different' }),
    row(spare.jti, { audience: 'different' }),
    row(spare.jti, { issued_at: -1 }),
    row(spare.jti, { issued_at: now + 500 }),
    row(spare.jti, { issued_at: now - 11 }),
    row(spare.jti, { expires_at: now }),
    row(spare.jti, { expires_at: now + 3601 }),
    row(spare.jti, { expires_at: 8640000000001 }),
    row(spare.jti, { issued_at: 0.5 }),
  ]
  for (const value of invalid) await assert.rejects(insert(admin, value))
  checks.push('identity-parent-ordinal-time-and-lifetime-rejections')
  const expired = await root(now - 20, now - 1)
  await assert.rejects(insert(admin, row(expired.jti)), /live predecessor/)
  const future = await root(now + 100, now + 300)
  await assert.rejects(insert(admin, row(future.jti)), /live predecessor/)
  const boundary =
    Number(
      (
        await admin`SELECT floor(extract(epoch FROM clock_timestamp()))::float8 AS n`
      )[0]?.n,
    ) + 3
  const expiring = await root(now - 10, boundary)
  const liveParent = row(expiring.jti)
  await insert(admin, liveParent)
  const shortRoot = await root(now - 10, now + 600)
  const shortParent = row(shortRoot.jti, { expires_at: boundary })
  await insert(admin, shortParent)
  // A bounded real-clock boundary test, not a mock of PostgreSQL time.
  await admin`SELECT pg_sleep(greatest(0,${boundary} - extract(epoch FROM clock_timestamp())) + 0.05)`
  await insert(
    admin,
    row(expiring.jti, {
      predecessor_jti: liveParent.jti,
      predecessor_successor_jti: liveParent.jti,
      ordinal: 2,
    }),
  )
  await assert.rejects(
    insert(
      admin,
      row(shortRoot.jti, {
        predecessor_jti: shortParent.jti,
        predecessor_successor_jti: shortParent.jti,
        ordinal: 2,
      }),
    ),
    /live predecessor/,
  )
  await assert.rejects(
    insert(admin, row(spare.jti, { expires_at: now + 1 })),
    /live predecessor/,
  )
  checks.push(
    'expired-and-future-anchor-denied-historical-root-with-live-parent-allowed',
  )
  for (const query of [
    admin`UPDATE farm.connector_credential_successors SET kid=kid WHERE jti=${successor.jti}::uuid`,
    admin`DELETE FROM farm.connector_credential_successors WHERE jti=${successor.jti}::uuid`,
    admin`TRUNCATE farm.connector_credential_successors`,
  ])
    await assert.rejects(query)
  await assert.rejects(
    admin`INSERT INTO farm.connector_credential_proofs(jti,observed_at,next_attempt_at) VALUES(${successor.jti}::uuid,${now * 1000},${now * 1000})`,
    { code: '23503' },
  )
  await assert.rejects(pause(successor.jti), { code: '23503' })
  assert.deepEqual((await snapshot()).proofs, before.proofs)
  assert.deepEqual((await snapshot()).pause, before.pause)
  checks.push('immutability-and-root-only-proof-pause-fks')
  await admin.begin(async (tx) => {
    for (const read of [
      readAcceptanceCredentialRecords,
      readSignallingCredentialRecords,
      readPauseNegotiationCredentialRecords,
      readRevocationCredentialRecords,
    ]) {
      const records = await read(tx, first.agent)
      assert.equal(records.length, 1)
      assert.equal(records[0]?.jti, first.jti)
    }
    assert.equal(
      (await readPauseAuthorityCredentialRecords(tx, first.agent, first.jti))[0]
        ?.jti,
      first.jti,
    )
    assert.deepEqual(
      [
        ...(await readPauseAuthorityCredentialRecords(
          tx,
          first.agent,
          successor.jti,
        )),
      ],
      [],
    )
  })
  checks.push(
    'all-five-a1-readers-stay-root-only-exact-binding-denies-successor',
  )
  const racing = await root()
  const forks = await Promise.allSettled([
    insert(admin, row(racing.jti)),
    insert(admin, row(racing.jti)),
  ])
  assert.equal(forks.filter((x) => x.status === 'fulfilled').length, 1)
  assert.equal(forks.filter((x) => x.status === 'rejected').length, 1)
  const revoke = (
    tx: Sql | TransactionSql,
    item: Awaited<ReturnType<typeof root>>,
  ) =>
    tx`UPDATE farm.connector_enrollments SET status='revoked' WHERE agent_id=${item.agent}::uuid`
  const tombstone = (
    tx: Sql | TransactionSql,
    item: Awaited<ReturnType<typeof root>>,
  ) =>
    tx`INSERT INTO farm.connector_revocations(agent_id,farm_id,fingerprint,credential_jti,revoked_at,revoked_by) VALUES(${item.agent}::uuid,${item.farm}::uuid,${'SHA256:' + digest},${item.jti}::uuid,${now * 1000},${account})`
  const revoked = await root()
  await revoke(admin, revoked)
  await assert.rejects(insert(admin, row(revoked.jti)), /approved unrevoked/)
  await tombstone(admin, revoked)
  await assert.rejects(insert(admin, row(revoked.jti)), /approved unrevoked/)
  // Ordered commits in both directions, with a second connection attempting
  // insertion while the enrollment lock is held; no timing/polling assumptions.
  const lockProbe = await root()
  await admin.begin(async (held) => {
    await held`SELECT agent_id FROM farm.connector_enrollments WHERE agent_id=${lockProbe.agent}::uuid FOR UPDATE`
    await assert.rejects(
      admin.begin(async (blocked) => {
        await blocked`SET LOCAL lock_timeout='100ms'`
        await insert(blocked, row(lockProbe.jti))
      }),
      { code: '55P03' },
    )
  })
  await admin.begin(async (held) => {
    await insert(held, row(lockProbe.jti))
    await assert.rejects(
      admin.begin(async (blocked) => {
        await blocked`SET LOCAL lock_timeout='100ms'`
        await revoke(blocked, lockProbe)
      }),
      { code: '55P03' },
    )
  })
  const revocationFirst = await root()
  let pendingInsert: Promise<unknown> | undefined
  await admin.begin(async (tx) => {
    await revoke(tx, revocationFirst)
    pendingInsert = Promise.resolve(
      insert(admin, row(revocationFirst.jti)),
    ).then(
      () => 'unexpected',
      () => 'denied',
    )
    await tombstone(tx, revocationFirst)
  })
  assert.equal(await pendingInsert, 'denied')
  const insertionFirst = await root()
  const chain = row(insertionFirst.jti)
  let pendingRevocation: Promise<unknown> | undefined
  await admin.begin(async (tx) => {
    await insert(tx, chain)
    pendingRevocation = admin.begin(async (other) => {
      await revoke(other, insertionFirst)
      await tombstone(other, insertionFirst)
    })
  })
  await pendingRevocation
  await assert.rejects(
    insert(
      admin,
      row(insertionFirst.jti, {
        predecessor_jti: chain.jti,
        predecessor_successor_jti: chain.jti,
        ordinal: 2,
      }),
    ),
    /approved unrevoked/,
  )
  checks.push('concurrent-fork-single-winner-and-both-revocation-lock-orders')

  const roles =
    await admin`SELECT rolname FROM pg_roles WHERE rolname LIKE 'farm_%' ORDER BY rolname`
  for (const role of roles) {
    const privileges =
      await admin`SELECT has_table_privilege(${role.rolname},'farm.connector_credential_successors','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS allowed`
    assert.equal(privileges[0]?.allowed, false, role.rolname)
    const columns =
      await admin`SELECT bool_or(has_column_privilege(${role.rolname},'farm.connector_credential_successors',attname,'SELECT,INSERT,UPDATE,REFERENCES')) AS allowed FROM pg_attribute WHERE attrelid='farm.connector_credential_successors'::regclass AND attnum>0 AND NOT attisdropped`
    assert.equal(columns[0]?.allowed, false, role.rolname)
  }
  const login = 'successor_fixture_' + randomUUID().replaceAll('-', '')
  await admin`CREATE ROLE ${admin(login)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_pause_authority`
  const pauseSql = postgres({
    host: '127.0.0.1',
    port,
    database: 'fixture',
    username: login,
    password: '',
    ssl: false,
    max: 1,
    connection: {
      options: '-c role=farm_pause_authority',
      search_path: 'pg_catalog',
      statement_timeout: 2000,
      lock_timeout: 1000,
      transaction_timeout: 10000,
    },
  })
  try {
    await validatePauseAuthorityRole(pauseSql)
    await admin`GRANT SELECT ON farm.connector_credential_successors TO farm_pause_authority`
    try {
      await assert.rejects(validatePauseAuthorityRole(pauseSql))
    } finally {
      await admin`REVOKE SELECT ON farm.connector_credential_successors FROM farm_pause_authority`
    }
    await validatePauseAuthorityRole(pauseSql)
  } finally {
    await pauseSql.end({ timeout: 3 })
    await admin`DROP ROLE ${admin(login)}`
  }
  checks.push('effective-table-column-privileges-and-pause-role-allowlist')
  const history = [
    ...(await admin`SELECT * FROM public.open3dfarm_migrations ORDER BY position`),
  ]
  const retained = [
    ...(await admin`SELECT * FROM farm.connector_credential_successors ORDER BY jti`),
  ]
  await assert.rejects(down(), /Cannot remove retained successor metadata/)
  assert.deepEqual(
    [
      ...(await admin`SELECT * FROM public.open3dfarm_migrations ORDER BY position`),
    ],
    history,
  )
  assert.deepEqual(
    [
      ...(await admin`SELECT * FROM farm.connector_credential_successors ORDER BY jti`),
    ],
    retained,
  )
  assert.deepEqual(
    [
      ...(await admin`SELECT * FROM farm.connector_credentials WHERE jti=${first.jti}::uuid`),
    ],
    before.roots,
  )
  checks.push('nonempty-down-preserves-successors-history-and-root')
  return checks
}
