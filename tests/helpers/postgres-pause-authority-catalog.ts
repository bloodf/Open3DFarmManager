import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import postgres, { type Sql } from 'postgres'
import {
  loadMigrationCatalog,
  runMigrations,
  validateMigrationHistory,
} from '../../scripts/db/migrations.ts'

const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')

async function journal(admin: Sql) {
  const catalog = await loadMigrationCatalog()
  assert.equal(catalog.length, 18)
  const rows =
    await admin`SELECT position,id,checksum FROM public.open3dfarm_migrations ORDER BY position`
  assert.equal(validateMigrationHistory(catalog, rows), 18)
  return hash(rows)
}

/** Caller owns an isolated, synthetic, initially empty maintained 0001..0018 database. */
export async function testPauseAuthorityCatalog(
  admin: Sql,
  port: number,
): Promise<string[]> {
  const initial = await journal(admin)
  const counts =
    await admin`SELECT (SELECT count(*) FROM farm.pause_authority_challenges)::int AS challenges,(SELECT count(*) FROM farm.pause_authority_sessions)::int AS sessions,(SELECT observed_at FROM farm.pause_authority_watermark)::float8 AS watermark`
  assert.deepEqual(
    { ...counts[0] },
    { challenges: 0, sessions: 0, watermark: 0 },
  )
  const catalog = await loadMigrationCatalog()
  await runMigrations(admin, catalog, {
    kind: 'down',
    expectedLastId: '0018_pause_authority',
  })
  const absent =
    await admin`SELECT to_regclass('farm.pause_authority_challenges') AS challenges,to_regclass('farm.pause_authority_sessions') AS sessions,to_regclass('farm.pause_authority_watermark') AS watermark,to_regprocedure('farm.prune_pause_authority()') AS prune,to_regprocedure('farm.pause_authority_lifecycle()') AS lifecycle,to_regprocedure('farm.observe_signalling_session_expiry(text)') IS NOT NULL AS observer,(SELECT count(*)::int FROM pg_catalog.pg_roles WHERE rolname IN ('farm_pause_authority','farm_pause_authority_retention_owner')) AS roles,(SELECT count(*)::int FROM public.open3dfarm_migrations) AS journal`
  assert.deepEqual(
    { ...absent[0] },
    {
      challenges: null,
      sessions: null,
      watermark: null,
      prune: null,
      lifecycle: null,
      observer: true,
      roles: 0,
      journal: 17,
    },
  )
  await runMigrations(admin, catalog, { kind: 'up' })
  assert.equal(await journal(admin), initial)
  const roles =
    await admin`SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_catalog.pg_roles WHERE rolname IN ('farm_pause_authority','farm_pause_authority_retention_owner') ORDER BY rolname`
  assert.equal(roles.length, 2)
  for (const role of roles)
    for (const flag of [
      'rolcanlogin',
      'rolsuper',
      'rolcreatedb',
      'rolcreaterole',
      'rolreplication',
      'rolbypassrls',
    ])
      assert.equal(role[flag], false)
  const functions =
    await admin`SELECT p.proname,p.prosecdef,p.proconfig,r.rolname AS owner FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace JOIN pg_catalog.pg_roles r ON r.oid=p.proowner WHERE n.nspname='farm' AND p.proname IN ('prune_pause_authority','pause_authority_lifecycle') ORDER BY p.proname`
  assert.equal(functions.length, 2)
  for (const fn of functions)
    assert.deepEqual(fn.proconfig, ['search_path=pg_catalog, farm, pg_temp'])
  assert.equal(functions[1]?.prosecdef, true)
  assert.equal(functions[1]?.owner, 'farm_pause_authority_retention_owner')
  const publicAcl =
    await admin`SELECT count(*)::int AS grants FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a WHERE n.nspname='farm' AND p.proname IN ('prune_pause_authority','observe_signalling_session_expiry') AND a.grantee=0 AND a.privilege_type='EXECUTE'`
  assert.equal(publicAcl[0]?.grants, 0)
  const role = 'pause_catalog_' + randomUUID().replaceAll('-', '')
  await admin`CREATE ROLE ${admin(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_pause_authority`
  const sql = postgres({
    host: '127.0.0.1',
    port,
    database: 'fixture',
    username: role,
    max: 1,
    connect_timeout: 3,
    connection: {
      options: '-c role=farm_pause_authority',
      statement_timeout: 2000,
      lock_timeout: 1000,
    },
  })
  try {
    const allowed =
      await sql`SELECT has_function_privilege(current_user,'farm.prune_pause_authority()','EXECUTE') AS prune,has_function_privilege(current_user,'farm.observe_signalling_session_expiry(text)','EXECUTE') AS observer,has_schema_privilege(current_user,'farm','CREATE') AS create_schema,has_table_privilege(current_user,'farm.account_sessions','UPDATE') AS session_update,has_column_privilege(current_user,'farm.connector_credentials','jti','UPDATE') AS credential_lock,has_column_privilege(current_user,'farm.connector_credentials','expires_at','UPDATE') AS revoke,has_table_privilege(current_user,'farm.connector_revocations','INSERT') AS revocation_insert`
    assert.deepEqual(
      { ...allowed[0] },
      {
        prune: true,
        observer: true,
        create_schema: false,
        session_update: false,
        credential_lock: true,
        revoke: false,
        revocation_insert: false,
      },
    )
    for (const query of [
      () => sql`SET ROLE farm_pause_authority_retention_owner`,
      () => sql`UPDATE farm.account_sessions SET last_seen_at=last_seen_at`,
      () => sql`UPDATE farm.browser_device_keys SET status='revoked'`,
      () => sql`DELETE FROM farm.pause_authority_challenges`,
      () => sql`TRUNCATE farm.pause_authority_challenges`,
      () => sql`CREATE TABLE farm.pause_catalog_forbidden(id integer)`,
    ])
      await assert.rejects(query)
    // A caller-controlled temporary schema must not redirect qualified SECURITY DEFINER work.
    await sql`CREATE TEMP TABLE pause_authority_watermark(id integer,observed_at bigint)`
    await sql`INSERT INTO pg_temp.pause_authority_watermark VALUES(1,9007199251140991)`
    await sql`CREATE FUNCTION pg_temp.clock_timestamp() RETURNS timestamptz LANGUAGE sql AS 'SELECT ''2000-01-01''::timestamptz'`
    await sql`SET search_path=pg_temp,public`
    await sql`SELECT farm.prune_pause_authority()`
    const shadow =
      await sql`SELECT observed_at::text AS value FROM pg_temp.pause_authority_watermark`
    assert.equal(shadow[0]?.value, '9007199251140991')
    const clock =
      await admin`SELECT observed_at::float8 AS value FROM farm.pause_authority_watermark`
    assert.ok(Number(clock[0]?.value) > 1_000_000_000_000)
  } finally {
    await sql.end({ timeout: 3 })
    await admin`DROP ROLE ${admin(role)}`
  }
  return [
    'maintained catalog 18 -> 17 -> 18 exact journal and objects',
    'NOLOGIN roles, function ownership/search_path/ACL, mutation/SET ROLE denials and temporary shadow isolation',
  ]
}

/** Run after real synthetic authority fixtures exist; no trigger disabling or fake journal writes. */
export async function testPauseAuthorityRetention(
  admin: Sql,
): Promise<string[]> {
  const before = await journal(admin)
  const auditSnapshot = async () =>
    hash(
      await admin`SELECT (SELECT jsonb_agg(to_jsonb(c) ORDER BY challenge_id) FROM farm.pause_authority_challenges c) AS challenges,(SELECT jsonb_agg(to_jsonb(s) ORDER BY session_id) FROM farm.pause_authority_sessions s) AS budgets,(SELECT observed_at::text FROM farm.pause_authority_watermark WHERE id=1) AS watermark,(SELECT jsonb_agg(to_jsonb(r) ORDER BY rolname) FROM pg_catalog.pg_roles r WHERE rolname IN ('farm_pause_authority','farm_pause_authority_retention_owner')) AS roles`,
    )
  const auditBefore = await auditSnapshot()
  await assert.rejects(
    runMigrations(admin, await loadMigrationCatalog(), {
      kind: 'down',
      expectedLastId: '0018_pause_authority',
    }),
    /Refusing to discard/,
  )
  assert.equal(await journal(admin), before)
  assert.equal(await auditSnapshot(), auditBefore)
  const sources =
    await admin`SELECT session_id,account_id,farm_id,agent_id,key_id,credential_jti,assignment_id FROM farm.pause_authority_challenges LIMIT 1`
  const source = sources[0]
  assert.ok(
    source,
    'retention phase needs an existing synthetic authority scope',
  )
  const ids: string[] = []
  const nowRows =
    await admin`SELECT floor(extract(epoch FROM pg_catalog.clock_timestamp())*1000)::float8 AS now`
  const old = Number(nowRows[0]?.now) - 7_200_000
  for (let i = 0; i < 130; i++) {
    const id = randomUUID()
    ids.push(id)
    await admin`INSERT INTO farm.pause_authority_challenges(challenge_id,session_id,account_id,farm_id,agent_id,key_id,credential_jti,assignment_id,transport_id,admission_nonce,binding,challenge,issued_at,expires_at,binding_expires_at,credential_expires_at) VALUES(${id},${source.session_id},${source.account_id},${source.farm_id},${source.agent_id},${source.key_id},${source.credential_jti},${source.assignment_id},${randomUUID()},${randomBytes(32).toString('base64url')},'{}','{}',${old},${old + 1000},${old + 1000},${old + 1000})`
  }
  // An actual trigger failure must roll back BOTH watermark and retention transitions.
  await admin`CREATE FUNCTION farm.pause_catalog_fail() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''synthetic prune failure''; END'`
  await admin`CREATE TRIGGER pause_catalog_fail BEFORE UPDATE ON farm.pause_authority_challenges FOR EACH ROW EXECUTE FUNCTION farm.pause_catalog_fail()`
  try {
    const prior =
      await admin`SELECT observed_at::text AS value FROM farm.pause_authority_watermark`
    await assert.rejects(
      admin`SELECT farm.prune_pause_authority()`,
      /synthetic prune failure/,
    )
    const after =
      await admin`SELECT observed_at::text AS value FROM farm.pause_authority_watermark`
    assert.deepEqual(after, prior)
    const pending =
      await admin`SELECT count(*)::int AS count FROM farm.pause_authority_challenges WHERE challenge_id IN ${admin(ids)} AND status='pending'`
    assert.equal(pending[0]?.count, 130)
  } finally {
    await admin`DROP TRIGGER pause_catalog_fail ON farm.pause_authority_challenges`
    await admin`DROP FUNCTION farm.pause_catalog_fail()`
  }
  // Newly expired rows retain a fresh one-hour audit horizon; prune cannot delete them immediately.
  await admin`SELECT farm.prune_pause_authority()`
  const states =
    await admin`SELECT count(*) FILTER(WHERE status='expired')::int AS expired,count(*) FILTER(WHERE status='pending')::int AS pending,count(*) FILTER(WHERE retain_until>=consumed_at+3600000)::int AS retained FROM farm.pause_authority_challenges WHERE challenge_id IN ${admin(ids)}`
  assert.deepEqual(
    { ...states[0] },
    { expired: 128, pending: 2, retained: 128 },
  )
  await admin`SELECT farm.prune_pause_authority()`
  const final =
    await admin`SELECT count(*)::int AS count FROM farm.pause_authority_challenges WHERE challenge_id IN ${admin(ids)} AND status='expired' AND retain_until>=greatest(expires_at,binding_expires_at,credential_expires_at,consumed_at)+3600000`
  assert.equal(final[0]?.count, 130)
  const insertHistoricalTerminal = async (issued: number) => {
    const id = randomUUID()
    const consumed = issued + 1000
    await admin`INSERT INTO farm.pause_authority_challenges(challenge_id,session_id,account_id,farm_id,agent_id,key_id,credential_jti,assignment_id,transport_id,admission_nonce,binding,challenge,issued_at,expires_at,binding_expires_at,credential_expires_at) VALUES(${id},${source.session_id},${source.account_id},${source.farm_id},${source.agent_id},${source.key_id},${source.credential_jti},${source.assignment_id},${randomUUID()},${randomBytes(32).toString('base64url')},'{}','{}',${issued},${consumed},${consumed},${consumed})`
    await admin`UPDATE farm.pause_authority_challenges SET status='rejected',consumed_at=${consumed},retain_until=${consumed + 3600000} WHERE challenge_id=${id}`
    return id
  }
  const deletable: string[] = []
  for (let i = 0; i < 130; i++)
    deletable.push(await insertHistoricalTerminal(old))
  await admin`SELECT farm.prune_pause_authority()`
  const left =
    await admin`SELECT count(*)::int AS count FROM farm.pause_authority_challenges WHERE challenge_id IN ${admin(deletable)}`
  assert.equal(left[0]?.count, 2)
  await admin`SELECT farm.prune_pause_authority()`
  const gone =
    await admin`SELECT count(*)::int AS count FROM farm.pause_authority_challenges WHERE challenge_id IN ${admin(deletable)}`
  assert.equal(gone[0]?.count, 0)
  // Boundary clock is always real PostgreSQL time, never a supplied/faked application clock.
  const boundaryNow =
    await admin`SELECT floor(extract(epoch FROM pg_catalog.clock_timestamp())*1000)::float8 AS now`
  const retainUntil = Number(boundaryNow[0]?.now) + 1000
  const boundary = await insertHistoricalTerminal(retainUntil - 3600000 - 1000)
  await admin`SELECT farm.prune_pause_authority()`
  const held =
    await admin`SELECT count(*)::int AS count FROM farm.pause_authority_challenges WHERE challenge_id=${boundary}`
  assert.equal(held[0]?.count, 1)
  await admin`SELECT pg_catalog.pg_sleep(greatest(0,(${retainUntil + 20}::float8-floor(extract(epoch FROM pg_catalog.clock_timestamp())*1000))/1000))`
  await admin`SELECT farm.prune_pause_authority()`
  const elapsed =
    await admin`SELECT count(*)::int AS count FROM farm.pause_authority_challenges WHERE challenge_id=${boundary}`
  assert.equal(elapsed[0]?.count, 0)
  return [
    'populated down refusal preserves exact journal, authority rows, roles and watermark',
    'retention failure atomically rolls back watermark/status; bounded 128 expiration/deletion, one-hour full-horizon guards and real DB retention boundary',
  ]
}

export interface PauseAuthorityRestartReceipt {
  version: 1
  processId: number
  systemIdentifier: string
  postmasterStartedAt: string
  journalHash: string
  watermark: number
  terminalRows: { challengeId: string; hash: string }[]
}
async function restartState(admin: Sql): Promise<PauseAuthorityRestartReceipt> {
  const server =
    await admin`SELECT (pg_catalog.pg_control_system()).system_identifier::text AS system,pg_catalog.pg_postmaster_start_time()::text AS started,(SELECT observed_at::float8 FROM farm.pause_authority_watermark WHERE id=1) AS watermark`
  const rows =
    await admin`SELECT challenge_id::text AS id,status,issued_at::text,expires_at::text,binding_expires_at::text,credential_expires_at::text,consumed_at::text,capability_id::text,capability_hash,capability_expires_at::text,retain_until::text FROM farm.pause_authority_challenges WHERE status<>'pending' ORDER BY challenge_id LIMIT 4097`
  assert.ok(rows.length > 0 && rows.length <= 4096)
  return {
    version: 1,
    processId: process.pid,
    systemIdentifier: String(server[0]?.system),
    postmasterStartedAt: String(server[0]?.started),
    journalHash: await journal(admin),
    watermark: Number(server[0]?.watermark),
    terminalRows: rows.map((row) => ({
      challengeId: String(row.id),
      hash: hash(row),
    })),
  }
}
/** Receipt contains no private login reference, credential, proof wire or key material. */
export async function capturePauseAuthorityRestart(
  admin: Sql,
): Promise<PauseAuthorityRestartReceipt> {
  return restartState(admin)
}
export async function verifyPauseAuthorityRestart(
  admin: Sql,
  expected: PauseAuthorityRestartReceipt,
): Promise<string[]> {
  assert.equal(expected.version, 1)
  const current = await restartState(admin)
  assert.notEqual(
    current.processId,
    expected.processId,
    'requires a distinct test process',
  )
  assert.equal(current.systemIdentifier, expected.systemIdentifier)
  assert.notEqual(
    current.postmasterStartedAt,
    expected.postmasterStartedAt,
    'requires an actual PostgreSQL postmaster restart',
  )
  assert.equal(current.journalHash, expected.journalHash)
  assert.ok(current.watermark >= expected.watermark)
  assert.deepEqual(current.terminalRows, expected.terminalRows)
  return [
    'distinct test process and actual same-cluster postmaster restart preserve exact journal, retained terminal hashes and original expiry horizons (adapter replay checked separately)',
  ]
}
