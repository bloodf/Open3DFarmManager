// Caller owns a disposable loopback PostgreSQL database with the maintained full migration journal.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile, realpath, lstat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative } from 'node:path'
import postgres, { type Sql } from 'postgres'
import {
  loadMigrationCatalog,
  validateMigrationHistory,
} from './db/migrations.ts'
import { ExtendedControlAction } from '../packages/farm-protocol/src/control-actions.ts'
import { freshAdvertisedActions } from '../apps/farm/server/storage/postgres-pause-authority.ts'
import { recordLatestStates } from '../apps/farm/server/storage/postgres-printer-latest-state.ts'
import { OBSERVATION_FRESH_MS } from '../apps/farm/server/utils/integration-telemetry.ts'
import {
  testPostgresPauseAuthority,
  verifyPauseAuthorityReplayRestart,
} from '../tests/helpers/postgres-pause-authority-integration.ts'
import {
  testPauseAuthorityCatalog,
  capturePauseAuthorityRestart,
  pauseAuthorityAdvertisedControlsMigrations,
  verifyPauseAuthorityRestart,
} from '../tests/helpers/postgres-pause-authority-catalog.ts'
import { testPauseConnectorRevocations } from '../tests/helpers/postgres-pause-authority-revocations.ts'
import {
  requirePauseTimeoutLogPath,
  testPauseAuthorityTransactionTimeout,
  type PauseTimeoutReceipt,
} from '../tests/helpers/postgres-pause-authority-timeout.ts'
const portText = process.env.PAUSE_AUTHORITY_SYNTHETIC_TEST_PORT,
  port = Number(portText)
const phase = process.argv[2] ?? 'run'
if (
  process.env.PAUSE_AUTHORITY_SYNTHETIC_TEST_DISPOSABLE !== 'yes' ||
  !portText ||
  !/^\d{4,5}$/.test(portText) ||
  port < 1024 ||
  port > 65535 ||
  !['run', 'prepare-restart', 'verify-restart'].includes(phase) ||
  process.argv.length > 3
)
  throw new Error(
    'Explicit disposable loopback PostgreSQL fixture and supported phase required',
  )
const base = process.env.PAUSE_AUTHORITY_SYNTHETIC_RESTART_BASE
if (phase !== 'run' && (!base || !isAbsolute(base)))
  throw new Error('Absolute private restart handoff path required')
if (base) {
  const checkout = await realpath(new URL('..', import.meta.url))
  const parent = await realpath(dirname(base))
  const worktrees = execFileSync(
    'git',
    ['worktree', 'list', '--porcelain', '-z'],
    {
      cwd: checkout,
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 1048576,
    },
  )
    .split('\0')
    .filter((entry) => entry.startsWith('worktree '))
  if (worktrees.length === 0)
    throw new Error('Cannot verify private handoff location')
  for (const entry of worktrees) {
    // A registered root removed by another task cannot contain the existing
    // handoff parent, so it needs no check.
    const root = await realpath(entry.slice('worktree '.length)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      },
    )
    if (root === undefined) continue
    const outside = relative(root, parent)
    if (!outside.startsWith('../') && outside !== '..')
      throw new Error(
        'Restart handoff must be outside every repository worktree',
      )
  }
}
if (
  phase === 'prepare-restart' &&
  process.env.PAUSE_AUTHORITY_SYNTHETIC_FUTURE_WATERMARK === 'yes'
)
  throw new Error('Use a separate fixture for injected future watermark')
// This is a path inside the caller-owned disposable PostgreSQL server, not the host.
const serverLogPath =
  phase === 'verify-restart'
    ? undefined
    : requirePauseTimeoutLogPath(
        process.env.PAUSE_AUTHORITY_SYNTHETIC_SERVER_LOG,
      )
const admin = postgres({
  host: '127.0.0.1',
  port,
  database: 'fixture',
  username: 'fixture',
  ssl: false,
  max: 6,
  connect_timeout: 3,
})

/**
 * This fixture stops at 0018, where the capability constraint does not yet
 * exist. Restore the shipped 0093 constraint, then its latest catalogued
 * redefinition, without applying unrelated migrations to the reduced schema.
 */
async function applyConfirmCollectionConstraint(admin: Sql): Promise<string[]> {
  const catalog = await loadMigrationCatalog()
  const initial = catalog.find(
    (entry) =>
      entry.up.includes('ADD CONSTRAINT control_capability_actions') &&
      entry.up.includes('"confirm_collection"') &&
      !entry.up.includes('"set_tool_temperature"'),
  )
  const latest = catalog.findLast(
    (entry) =>
      entry.up.includes('ADD CONSTRAINT control_capability_actions') &&
      entry.up.includes('"set_tool_temperature"'),
  )
  if (!initial || !latest || initial.id >= latest.id)
    throw new Error('Missing shipped pause authority constraint chain')
  const definition = async () =>
    await admin`SELECT pg_catalog.pg_get_constraintdef(c.oid) AS definition FROM pg_catalog.pg_constraint c WHERE c.conname='control_capability_actions' AND c.conrelid='farm.pause_authority_challenges'::regclass`
  if ((await definition()).length === 0) {
    // The placeholder only gives the shipped drop its target.
    await admin.begin(async (tx) => {
      await tx`ALTER TABLE farm.pause_authority_challenges ADD CONSTRAINT control_capability_actions CHECK (true) NOT VALID`
      await tx.unsafe(initial.up).simple()
    })
  }
  const afterInitial = await definition()
  assert.equal(afterInitial.length, 1)
  assert.ok(
    afterInitial[0]?.definition.includes('confirm_collection'),
    'the shipped 0093 constraint must accept confirm_collection',
  )
  assert.ok(
    !afterInitial[0]?.definition.includes('set_tool_temperature'),
    '0093 must retain its own action allow-list before the later redefinition',
  )

  const redefinition = latest.up.match(
    /ALTER TABLE farm\.pause_authority_challenges DROP CONSTRAINT control_capability_actions;\s*ALTER TABLE farm\.pause_authority_challenges ADD CONSTRAINT control_capability_actions CHECK \([\s\S]*?\);/,
  )
  assert.ok(
    redefinition,
    'latest catalogued constraint redefinition is present',
  )
  await admin.begin(async (tx) => {
    await tx.unsafe(redefinition[0]).simple()
  })
  const applied = await definition()
  assert.equal(applied.length, 1)
  assert.ok(
    applied[0]?.definition.includes('set_tool_temperature'),
    'the latest shipped constraint must accept set_tool_temperature',
  )
  assert.ok(
    applied[0]?.definition.includes('confirm_collection'),
    'the latest shipped constraint must retain confirm_collection',
  )
  return [
    'shipped 0093 constraint guards stored capabilities, followed by latest catalogued redefinition ' +
      latest.id,
  ]
}

/** Store a capability carrying confirm_collection, exactly as a browser journey does. */
async function storeConfirmCollectionCapability(admin: Sql): Promise<string[]> {
  const sources =
    await admin`SELECT session_id,account_id,farm_id,agent_id,key_id,credential_jti,assignment_id FROM farm.pause_authority_challenges ORDER BY challenge_id LIMIT 1`
  const source = sources[0]
  assert.ok(source, 'the fixture must hold a synthetic pause authority scope')
  const insert = async (capability: Record<string, unknown>) => {
    const challengeId = randomUUID()
    const now = Date.now()
    await admin`INSERT INTO farm.pause_authority_challenges(challenge_id,session_id,account_id,farm_id,agent_id,key_id,credential_jti,assignment_id,transport_id,admission_nonce,binding,challenge,issued_at,expires_at,binding_expires_at,credential_expires_at) VALUES(${challengeId}::uuid,${source.session_id},${source.account_id},${source.farm_id}::uuid,${source.agent_id}::uuid,${source.key_id}::uuid,${source.credential_jti}::uuid,${source.assignment_id}::uuid,${randomUUID()}::uuid,${randomBytes(32).toString('base64url')},'{}'::jsonb,'{}'::jsonb,${now},${now + 8000},${now + 8000},${now + 8000})`
    const consumed = now + 1000
    const hash = createHash('sha256')
      .update(JSON.stringify(capability))
      .digest('base64url')
    await admin`UPDATE farm.pause_authority_challenges SET status='issued',consumed_at=${consumed},capability_id=${randomUUID()}::uuid,capability=${admin.json(capability)},capability_hash=${hash},capability_expires_at=${consumed + 30000},retain_until=greatest(${consumed},expires_at,binding_expires_at,credential_expires_at,${consumed + 30000})+3600000 WHERE challenge_id=${challengeId}::uuid`
    return challengeId
  }
  // An owner holds every control action, the bed-collection hold included.
  const owner = await insert({
    actions: [...ExtendedControlAction.options],
    role: 'owner',
  })
  const stored =
    await admin`SELECT status,capability->'actions' ? 'confirm_collection' AS has_confirm,capability->'actions' ? 'set_tool_temperature' AS has_tool_temperature FROM farm.pause_authority_challenges WHERE challenge_id=${owner}::uuid`
  assert.ok(stored[0], 'the stored capability must be readable')
  assert.deepEqual(
    { ...stored[0] },
    {
      status: 'issued',
      has_confirm: true,
      has_tool_temperature: true,
    },
  )
  // An action outside the protocol stays refused by the same constraint.
  await assert.rejects(
    insert({
      actions: ['confirm_collection', 'teleport_printer'],
      role: 'operator',
    }),
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === '23514' &&
      'constraint_name' in error &&
      error.constraint_name === 'control_capability_actions',
  )
  return [
    'stored capability with confirm_collection and set_tool_temperature accepted, unknown action refused',
  ]
}
try {
  const identity = (
    await admin`SELECT current_database() AS database,current_user AS username`
  )[0]
  assert.deepEqual(
    { ...identity },
    { database: 'fixture', username: 'fixture' },
  )
  const catalog = (await loadMigrationCatalog()).slice(0, 18),
    history =
      await admin`SELECT position,id,checksum FROM public.open3dfarm_migrations ORDER BY position`
  assert.equal(catalog.length, 18)
  assert.equal(catalog.at(-1)?.id, '0018_pause_authority')
  assert.equal(validateMigrationHistory(catalog, [...history]), 18)
  let checks: string[]
  let timeout: PauseTimeoutReceipt | undefined
  if (phase === 'verify-restart') {
    if (!base) throw new Error('Missing restart base')
    for (const path of [base + '.private.json', base + '.catalog.json']) {
      const details = await lstat(path)
      if (
        !details.isFile() ||
        details.isSymbolicLink() ||
        (details.mode & 0o077) !== 0 ||
        details.size > 1048576
      )
        throw new Error('Invalid private restart handoff')
    }
    const receipt = JSON.parse(await readFile(base + '.catalog.json', 'utf8'))
    checks = [
      ...(await verifyPauseAuthorityRestart(admin, receipt)),
      ...(await verifyPauseAuthorityReplayRestart(
        admin,
        port,
        base + '.private.json',
      )),
    ]
  } else {
    const catalogChecks = await testPauseAuthorityCatalog(admin, port)
    // Keep the 0018 catalog and restart assertions, but exercise the current
    // issuer against the shipped telemetry table and its restricted view.
    const controlsMigrations =
      await pauseAuthorityAdvertisedControlsMigrations()
    await admin.begin(async (tx) => {
      for (const migration of controlsMigrations)
        await tx.unsafe(migration.up).simple()
    })
    const farmId = randomUUID(),
      agentId = randomUUID(),
      now = Date.now(),
      staleReceipt = now - OBSERVATION_FRESH_MS - 1
    await admin`INSERT INTO farm.printer_latest_state (farm_id, agent_id, printer_key, observed_at, received_at, age_at_send_ms, state) VALUES (${farmId}::uuid, ${agentId}::uuid, 'freshness-fixture', ${staleReceipt + 20_000}, ${staleReceipt}, 0, ${admin.json({ controls: ['pause', 'start_print'] })})`
    const readControls = () =>
      admin`SELECT controls, age_at_send_ms::float8 AS age_at_send_ms, received_at::float8 AS received_at, floor(extract(epoch FROM pg_catalog.clock_timestamp())*1000)::float8 AS now FROM farm.pause_authority_advertised_controls WHERE farm_id=${farmId}::uuid AND agent_id=${agentId}::uuid AND printer_key='freshness-fixture'`
    const eligibleControls = async () => {
      const [row] = await readControls()
      assert.ok(row)
      return freshAdvertisedActions(
        row.controls,
        row.age_at_send_ms,
        row.received_at,
        row.now,
      )
    }
    assert.deepEqual(await eligibleControls(), ['pause'])
    await admin`UPDATE farm.printer_latest_state
      SET state = ${admin.json({ controls: ['set_temperature', 'home', 'run_macro', 'start_print'] })}
      WHERE farm_id=${farmId}::uuid AND agent_id=${agentId}::uuid AND printer_key='freshness-fixture'`
    assert.deepEqual(await eligibleControls(), [])
    // A pre-migration row may already contain a poisoned timestamp.
    await admin`UPDATE farm.printer_latest_state SET observed_at=${now + 120_000}, received_at=NULL WHERE farm_id=${farmId}::uuid AND agent_id=${agentId}::uuid AND printer_key='freshness-fixture'`
    await admin.begin((tx) =>
      recordLatestStates(tx, { farmId, agentId }, [
        {
          eventId: randomUUID(),
          queuedAt: now,
          kind: 'printer-state',
          ageAtSendMs: 0,
          state: {
            printerKey: 'freshness-fixture',
            observedAt: now + 20_000,
            state: 'paused',
            progress: 0.5,
            controls: ['pause', 'start_print'],
          },
        },
      ]),
    )
    const released = (await readControls())[0]!
    assert.deepEqual(
      freshAdvertisedActions(
        released.controls,
        released.age_at_send_ms,
        released.received_at,
        released.now,
      ),
      ['pause', 'start_print'],
    )
    await admin`DELETE FROM farm.printer_latest_state WHERE farm_id=${farmId}::uuid AND agent_id=${agentId}::uuid AND printer_key='freshness-fixture'`
    // The catalog check rebuilds 0018, so the shipped constraint comes next.
    const constraintChecks = await applyConfirmCollectionConstraint(admin)
    const revocationChecks = await testPauseConnectorRevocations(admin, port)
    assert.ok(serverLogPath)
    timeout = await testPauseAuthorityTransactionTimeout(
      admin,
      port,
      serverLogPath,
    )
    checks = [
      ...catalogChecks,
      'stale advertised controls grant only listed stops, including when no stop is listed',
      ...constraintChecks,
      ...revocationChecks,
      'server-attributed-ten-second-transaction-timeout-before-main-pool',
      ...(await testPostgresPauseAuthority(
        admin,
        port,
        phase === 'prepare-restart' && base
          ? base + '.private.json'
          : undefined,
      )),
      ...(await storeConfirmCollectionCapability(admin)),
    ]
    if (phase === 'prepare-restart') {
      if (!base) throw new Error('Missing restart base')
      await writeFile(
        base + '.catalog.json',
        JSON.stringify(await capturePauseAuthorityRestart(admin)),
        { flag: 'wx', mode: 0o600 },
      )
    }
  }
  console.log(
    JSON.stringify({ result: 'passed', phase, checks, journal: 18, timeout }),
  )
} finally {
  await admin.end({ timeout: 3 })
}
