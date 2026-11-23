import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  IntegrationDeliveryService,
  type EnvelopeRecord,
  type IntegrationDeliveryStore,
} from '../../apps/farm/server/services/integration-delivery.ts'
import { IntegrationAuditService } from '../../apps/farm/server/services/integration-audit.ts'
import { replayReusedJob } from '../helpers/api-v1-contract/replay.ts'
import { createCommitHold } from '../helpers/connector-outage-fixtures.ts'
import { disposablePostgres } from '../helpers/disposable-postgres.ts'
import {
  deniedAuthorityObserved,
  secretSetAccepted,
} from '../helpers/kobralink-rtc/qualification.ts'
import { releaseOnFailure, withOwnedCleanup } from '../helpers/owned-cleanup.ts'
import { pageFetch } from '../helpers/page-fetch.ts'
import { disposePageResources } from '../helpers/page-resources.ts'
import { createPauseChildLifetime } from '../helpers/pause-execution-rtc-connector-child.ts'
import { createRecordingDeliveryInbox } from '../helpers/postgres-integration-delivery-integration.ts'
import { visibleWithinReadOnlyDeadline } from '../helpers/read-only-deadline.ts'

test('a commit hold times out, aborts and releases an intercepted response', async () => {
  const timed = createCommitHold()
  await assert.rejects(
    () => timed.holdNextCommit({ timeoutMs: 20 }),
    /commit hold timed out/,
  )

  const aborted = createCommitHold()
  await assert.rejects(
    () =>
      aborted.holdNextCommit({
        timeoutMs: 5_000,
        signal: AbortSignal.abort(),
      }),
    /commit hold aborted/,
  )

  const closed = createCommitHold()
  const waiting = closed.holdNextCommit({ timeoutMs: 5_000 })
  closed.close()
  await assert.rejects(waiting, /commit hold closed/)

  const held = createCommitHold()
  let released = false
  const pending = held.holdNextCommit({ timeoutMs: 5_000 })
  assert.equal(
    held.intercept(['event-1'], () => {
      released = true
    }),
    true,
  )
  assert.deepEqual((await pending).eventIds, ['event-1'])
  held.close()
  assert.equal(released, true)
})

test('page setup closes the listener when context close fails', async () => {
  const closed: string[] = []
  await assert.rejects(
    () =>
      disposePageResources({
        context: {
          close: async () => {
            closed.push('context')
            throw new Error('context close failed')
          },
        },
        server: {
          close: async () => {
            closed.push('server')
          },
        },
      }),
    /context close failed/,
  )
  assert.deepEqual(closed, ['context', 'server'])
})

test('page fetch does not dispatch an already-aborted signal', async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    await assert.rejects(
      () => pageFetch('http://127.0.0.1/item', { signal: AbortSignal.abort() }),
      (error: unknown) =>
        error instanceof DOMException && error.name === 'AbortError',
    )
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = original
  }
})

test('page fetch removes the abort listener when the call settles', async () => {
  const controller = new AbortController()
  const signal = controller.signal
  const add = AbortSignal.prototype.addEventListener
  const remove = AbortSignal.prototype.removeEventListener
  const events: string[] = []
  AbortSignal.prototype.addEventListener = function (
    this: AbortSignal,
    ...args: Parameters<typeof add>
  ) {
    if (this === signal && args[0] === 'abort') events.push('add')
    return add.apply(this, args)
  }
  AbortSignal.prototype.removeEventListener = function (
    this: AbortSignal,
    ...args: Parameters<typeof remove>
  ) {
    if (this === signal && args[0] === 'abort') events.push('remove')
    return remove.apply(this, args)
  }
  const original = globalThis.fetch
  globalThis.fetch = async () =>
    new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  try {
    assert.deepEqual(await pageFetch('http://127.0.0.1/item', { signal }), {})
    assert.deepEqual(events, ['add', 'remove'])
  } finally {
    AbortSignal.prototype.addEventListener = add
    AbortSignal.prototype.removeEventListener = remove
    globalThis.fetch = original
  }
})

test('read-only visibility uses the time remaining on one deadline', async () => {
  let budget = 0
  const elapsed = await visibleWithinReadOnlyDeadline(
    1_000,
    async (timeout) => {
      budget = timeout
    },
    () => 3_000,
  )
  assert.equal(budget, 8_000)
  assert.equal(elapsed, 2_000)

  await assert.rejects(
    () =>
      visibleWithinReadOnlyDeadline(
        0,
        async () => {},
        () => 10_000,
      ),
    /read-only deadline elapsed/,
  )

  let clock = 0
  await assert.rejects(
    () =>
      visibleWithinReadOnlyDeadline(
        0,
        async () => {
          clock = 11_000
        },
        () => clock,
      ),
    /read-only visibility exceeded the deadline/,
  )
})

test('child disposal joins startup and releases the close barrier', async () => {
  const late = createPauseChildLifetime()
  let opened = false
  const waiting = late.holdClose().then(() => {
    opened = true
  })
  await late.dispose(async () => {})
  await waiting
  assert.equal(opened, true)
  const started = Date.now()
  await late.holdClose()
  assert.ok(Date.now() - started < 200)

  const life = createPauseChildLifetime()
  const root = mkdtempSync(join(tmpdir(), 'pause-lifetime-'))
  let created = ''
  let releaseStartup!: () => void
  const gate = new Promise<void>((resolve) => {
    releaseStartup = resolve
  })
  life.openStartup()
  const startup = (async () => {
    await gate
    created = mkdtempSync(join(root, 'journal-'))
    life.finishStartup()
  })()
  let finished = false
  const done = life.dispose(async () => {
    if (created) rmSync(created, { recursive: true, force: true })
  })
  void done.then(
    () => {
      finished = true
    },
    () => {},
  )
  try {
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(finished, false)
    releaseStartup()
    await startup
    await done
    assert.equal(finished, true)
    assert.equal(existsSync(created), false)
  } finally {
    releaseStartup()
    life.finishStartup()
    rmSync(root, { recursive: true, force: true })
  }
})

test('owned cleanup reaps a child and a listener when later setup fails', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: ['pipe', 'ignore', 'ignore'],
  })
  await assert.rejects(
    () =>
      withOwnedCleanup(async (own) => {
        own(async () => {
          if (child.exitCode === null && child.signalCode === null)
            child.kill('SIGKILL')
          await once(child, 'exit')
        })
        throw new Error('journal failed')
      }),
    /journal failed/,
  )
  assert.ok(child.exitCode !== null || child.signalCode !== null)

  const first = createServer()
  await new Promise<void>((resolve) => {
    first.listen(0, '127.0.0.1', () => resolve())
  })
  await assert.rejects(
    () =>
      withOwnedCleanup(async (own) => {
        own(
          () =>
            new Promise<void>((resolve, reject) => {
              first.close((error) => (error ? reject(error) : resolve()))
            }),
        )
        throw new Error('listen failed')
      }),
    /listen failed/,
  )
  assert.equal(first.listening, false)
})

test('built telemetry startup releases a proxy and app when a later step fails', async () => {
  const closed: string[] = []
  await assert.rejects(
    () =>
      releaseOnFailure(async (hold) => {
        hold(async () => {
          closed.push('proxy')
        })
        throw new Error('ENOSPC')
      }),
    /ENOSPC/,
  )
  assert.deepEqual(closed, ['proxy'])

  closed.length = 0
  await assert.rejects(
    () =>
      releaseOnFailure(async (hold) => {
        hold(async () => {
          closed.push('proxy')
        })
        hold(async () => {
          closed.push('app')
        })
        throw new Error('ENOSPC')
      }),
    /ENOSPC/,
  )
  assert.deepEqual(closed, ['app', 'proxy'])

  closed.length = 0
  assert.equal(
    await releaseOnFailure(async (hold) => {
      hold(async () => {
        closed.push('proxy')
      })
      return 'ready'
    }),
    'ready',
  )
  assert.deepEqual(closed, [])
})

test('revocation evidence requires a denied submission or the withdrawn-authority alert', () => {
  assert.equal(
    deniedAuthorityObserved({
      stage: 'form',
      alert: '',
      channelOut: [],
      authorityStatuses: [],
      nothingCreated: true,
    }),
    false,
  )
  assert.equal(
    deniedAuthorityObserved({
      stage: 'form',
      alert:
        'Autorização recusada ou revogada pelo Connector. Confira sua permissão.',
      channelOut: [],
      authorityStatuses: [],
      nothingCreated: true,
    }),
    true,
  )
  assert.equal(
    deniedAuthorityObserved({
      stage: 'form',
      alert: '',
      channelOut: ['proof'],
      authorityStatuses: [403],
      nothingCreated: true,
    }),
    true,
  )
  assert.equal(
    deniedAuthorityObserved({
      stage: 'prepared',
      alert:
        'Autorização recusada ou revogada pelo Connector. Confira sua permissão.',
      channelOut: [],
      authorityStatuses: [403],
      nothingCreated: true,
    }),
    false,
  )
})

test('secret acceptance requires connector-state markers and a complete inspection', () => {
  assert.equal(
    secretSetAccepted({ secrets: 4, connectorSecrets: 0, truncated: false }),
    false,
  )
  assert.equal(
    secretSetAccepted({ secrets: 5, connectorSecrets: 1, truncated: false }),
    true,
  )
  assert.equal(
    secretSetAccepted({ secrets: 5, connectorSecrets: 1, truncated: true }),
    false,
  )
})

test('job replay requires the original id and a single persisted job', () => {
  assert.doesNotThrow(() =>
    replayReusedJob({
      firstStatus: 202,
      firstId: 'job-1',
      secondId: 'job-1',
      persisted: 1,
    }),
  )
  assert.throws(
    () =>
      replayReusedJob({
        firstStatus: 202,
        firstId: 'job-1',
        secondId: 'job-2',
        persisted: 2,
      }),
    /different job/,
  )
  assert.throws(
    () =>
      replayReusedJob({
        firstStatus: 500,
        firstId: undefined,
        secondId: 'job-2',
        persisted: 1,
      }),
    /not accepted/,
  )
})

test('the delivery inbox records authority scope and confirmation time', async () => {
  const confirmedAt = 1_700_000_000_000
  const record: EnvelopeRecord = {
    cmdId: '00000000-0000-4000-8000-000000000001',
    appId: 'app',
    grantId: 'grant',
    farmId: 'farm',
    agentId: 'agent',
    printerAssignmentId: 'printer',
    kind: 'job',
    resourceId: 'resource',
    requiredScope: 'jobs:start',
    nonce: 'n',
    wire: 'wire',
    issuedAt: confirmedAt,
    expiresAt: confirmedAt + 1_000,
    status: 'sending',
    refusalCode: null,
    resultDetail: null,
    historyEntryId: null,
    createdAt: confirmedAt,
    updatedAt: confirmedAt,
  }
  const inbox = createRecordingDeliveryInbox()
  const store: IntegrationDeliveryStore = {
    insert: async () => {
      throw new Error('unused')
    },
    get: async () => record,
    listPending: async () => [],
    claim: async () => record,
    settleUnclaimable: async () => null,
    transition: async () => ({ ...record, status: 'sent' }),
    sweep: async () => [],
  }
  const pair = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const service = new IntegrationDeliveryService({
    store,
    inbox,
    audit: { record: async () => {} } as unknown as IntegrationAuditService,
    signer: { kid: 'api-1', signingKey: pair.privateKey },
    now: () => confirmedAt,
  })
  assert.equal(await service.deliver(record.cmdId), 'sent')
  assert.deepEqual(inbox.authorities, [{ scope: 'jobs:start', confirmedAt }])
  assert.ok(inbox.authorities[0]?.confirmedAt !== 0)
})

test('an existing cluster drops its owned role and omits credentials from the ledger', async () => {
  const previousUrl = process.env.OPENFARM_TEST_DATABASE_URL
  const previousPg = process.env.OPENFARM_PG
  delete process.env.OPENFARM_PG
  const parent = disposablePostgres({
    name: `pg700a${randomBytes(3).toString('hex')}`,
    isolated: true,
    through: false,
  })
  let parentSql: Awaited<ReturnType<typeof parent.start>> | undefined
  try {
    parentSql = await parent.start()
    const password = parent.password
    process.env.OPENFARM_TEST_DATABASE_URL = parent.connectionString
    const success: object[] = []
    const child = disposablePostgres({
      name: `pg700b${randomBytes(3).toString('hex')}`,
      through: false,
      ledger: (value) => {
        success.push(value)
      },
    })
    const sql = await child.start()
    try {
      const actor = await sql`SELECT current_user AS actor`
      assert.match(String(actor[0]?.actor), /^o3dfm_fixture_[a-f0-9]+$/)
      const text = JSON.stringify(success)
      assert.equal(text.includes(password), false)
      assert.equal(text.includes('postgresql://'), false)
      assert.equal(
        (
          await parentSql`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'fixture'`
        )[0]?.n,
        1,
      )
    } finally {
      await child.stop()
    }
    assert.equal(
      (
        await parentSql`SELECT count(*)::int AS n FROM pg_roles WHERE rolname LIKE 'o3dfm_fixture_%'`
      )[0]?.n,
      0,
    )
    assert.equal(
      (
        await parentSql`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'fixture'`
      )[0]?.n,
      1,
    )

    const failed: object[] = []
    const broken = disposablePostgres({
      name: `pg700c${randomBytes(3).toString('hex')}`,
      through: false,
      ledger: (value) => {
        failed.push(value)
        if (
          value &&
          typeof value === 'object' &&
          'resource' in value &&
          value.resource === 'database'
        )
          throw new Error('ledger failed')
      },
    })
    await assert.rejects(() => broken.start(), /ledger failed/)
    assert.equal(JSON.stringify(failed).includes(password), false)
    assert.equal(
      (
        await parentSql`SELECT count(*)::int AS n FROM pg_roles WHERE rolname LIKE 'o3dfm_fixture_%'`
      )[0]?.n,
      0,
    )
    assert.equal(
      (
        await parentSql`SELECT count(*)::int AS n FROM pg_database WHERE datname LIKE 'o3dfm_test_%'`
      )[0]?.n,
      0,
    )
  } finally {
    await parentSql?.end({ timeout: 3 }).catch(() => {})
    await parent.stop().catch(() => {})
    if (previousUrl === undefined) delete process.env.OPENFARM_TEST_DATABASE_URL
    else process.env.OPENFARM_TEST_DATABASE_URL = previousUrl
    if (previousPg === undefined) delete process.env.OPENFARM_PG
    else process.env.OPENFARM_PG = previousPg
  }
})
