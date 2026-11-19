import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  migrateLibrary,
  type LibraryTransferPort,
} from '../../packages/connector/src/runtime/library-migration.ts'
import {
  createLibraryStore,
  LibraryStoreError,
} from '../../packages/connector/src/runtime/library-store.ts'
import {
  LibraryMigrationRequest,
  LibraryMigrationResult,
  planMigration,
  summarizeMigration,
  type LibraryMigrationDirectionValue,
  type LibraryMigrationVersionValue,
} from '../../packages/farm-protocol/src/library-storage.ts'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const bytes = (text: string): AsyncIterable<Uint8Array> =>
  (async function* () {
    yield Buffer.from(text)
  })()
const text = async (source: AsyncIterable<Uint8Array>) => {
  const parts: Buffer[] = []
  for await (const chunk of source) parts.push(Buffer.from(chunk))
  return Buffer.concat(parts).toString()
}

let n = 0
const version = (
  content: string,
  location: 'server' | 'connector',
  over: Partial<LibraryMigrationVersionValue> = {},
): LibraryMigrationVersionValue => ({
  version_id: `ver${++n}`,
  item_id: `item${n}`,
  version_number: 1,
  sha256: sha(content),
  size_bytes: Buffer.byteLength(content),
  name: `${content}.gcode`,
  kind: 'gcode',
  created_at: 1_800_000_000_000 + n,
  location,
  purged: false,
  pinned: false,
  ...over,
})

async function open(quotaBytes?: number, freeBytes?: () => Promise<number>) {
  await mkdir(join(process.cwd(), '.data'), { recursive: true })
  const directory = await mkdtemp(
    join(process.cwd(), '.data', 'library-switch-'),
  )
  const store = await createLibraryStore({
    directory,
    freeBytes: freeBytes ?? (async () => 1e12),
    ...(quotaBytes === undefined ? {} : { quotaBytes }),
  })
  return { store, directory }
}
const stored = async (directory: string) =>
  (await readdir(directory)).filter((name) => /^[0-9a-f]{64}$/.test(name))

/** In-memory server side of the session: no network. */
function fakeServer(files: Record<string, string> = {}) {
  const pulled: string[] = []
  const pushed: string[] = []
  const received = new Map<string, string>()
  const options: { failPush?: boolean; failPull?: Set<string> } = {}
  const port: LibraryTransferPort = {
    async pull(hash) {
      pulled.push(hash)
      const content = Object.entries(files).find(
        ([, c]) => sha(c) === hash,
      )?.[1]
      if (options.failPull?.has(hash) || content === undefined)
        throw new LibraryStoreError('not-found')
      return bytes(content)
    },
    async push(hash, size, source) {
      pushed.push(hash)
      if (options.failPush) throw new Error('connection dropped')
      const body = await text(source)
      expect(Buffer.byteLength(body)).toBe(size)
      received.set(hash, body)
    },
  }
  return { port, pulled, pushed, received, options }
}

const run = (
  direction: LibraryMigrationDirectionValue,
  versions: LibraryMigrationVersionValue[],
  store: Awaited<ReturnType<typeof open>>['store'],
  transfer: LibraryTransferPort,
) => migrateLibrary({ direction, versions, store, transfer })
const byId = (outcomes: Awaited<ReturnType<typeof run>>) =>
  Object.fromEntries(outcomes.map((o) => [o.version_id, o]))

describe('plan', () => {
  test('one transfer per hash; settled versions need none', () => {
    const a = version('same', 'server')
    const b = version('same', 'server')
    const done = version('done', 'connector')
    const purged = version('old', 'server', { purged: true })
    const plan = planMigration('server-to-connector', [a, b, done, purged])
    expect(plan.moves).toHaveLength(1)
    expect(plan.moves[0]?.versions.map((v) => v.version_id)).toEqual([
      a.version_id,
      b.version_id,
    ])
    expect(plan.settled.map((o) => [o.outcome, o.reason])).toEqual([
      ['already-there', undefined],
      ['stays', 'purged'],
    ])
  })

  test('request and result frames validate', () => {
    const v = version('x', 'server')
    expect(
      LibraryMigrationRequest.parse({
        type: 'library.migrate',
        request_id: 'r1',
        direction: 'server-to-connector',
        versions: [{ ...v, pinned: undefined }],
      }).versions[0]?.pinned,
    ).toBe(false)
    expect(
      LibraryMigrationResult.safeParse({
        type: 'library.migrate.result',
        request_id: 'r1',
        direction: 'connector-to-server',
        outcomes: [
          {
            version_id: 'a',
            sha256: sha('x'),
            location: 'server',
            outcome: 'moved',
            bytes: 'no',
          },
        ],
      }).success,
    ).toBe(false)
  })
})

describe('server to Connector', () => {
  test('moves every version, deduplicated, and replay works afterwards', async () => {
    const { store, directory } = await open()
    const files = { alpha: 'alpha-bytes', beta: 'beta-bytes' }
    const server = fakeServer(files)
    const versions = [
      version('alpha-bytes', 'server'),
      version('alpha-bytes', 'server'), // same bytes, second version
      version('beta-bytes', 'server', { pinned: true }),
    ]
    const outcomes = await run(
      'server-to-connector',
      versions,
      store,
      server.port,
    )
    expect(
      outcomes.every(
        (o) => o.outcome === 'moved' && o.location === 'connector',
      ),
    ).toBe(true)
    expect(server.pulled).toEqual([sha('alpha-bytes'), sha('beta-bytes')]) // one pull per hash
    expect(await stored(directory)).toHaveLength(2)
    const listed = await store.list()
    expect(listed).toHaveLength(3)
    expect(listed.find((f) => f.sha256 === sha('beta-bytes'))?.pinned).toBe(
      true,
    )
    // Replay: hash is re-verified in the Connector before use.
    expect((await store.openForPrint(sha('alpha-bytes'))).size).toBe(11)
    expect(summarizeMigration(outcomes)).toMatchObject({
      moved: 3,
      stays: 0,
      messages: [],
    })
  })

  test('a corrupted transfer is refused and the version stays on the server', async () => {
    const { store, directory } = await open()
    const good = version('good', 'server')
    const bad = version('claimed', 'server') // server serves other bytes for this hash
    const server = fakeServer({ good: 'good' })
    const lying: LibraryTransferPort = {
      pull: (hash) =>
        hash === bad.sha256
          ? Promise.resolve(bytes('tampered'))
          : server.port.pull(hash, 0),
      push: server.port.push,
    }
    const outcomes = byId(
      await run('server-to-connector', [good, bad], store, lying),
    )
    expect(outcomes[good.version_id]).toMatchObject({
      outcome: 'moved',
      location: 'connector',
    })
    expect(outcomes[bad.version_id]).toMatchObject({
      outcome: 'stays',
      location: 'server',
      reason: 'hash-mismatch',
    })
    expect(await stored(directory)).toEqual([good.sha256])
    expect(await store.list()).toHaveLength(1)
  })

  test('lists, per version, what stays and where: quota, full disk, purged, missing on the server', async () => {
    const { store } = await open(12)
    const fits = version('12345678', 'server')
    const overQuota = version('abcdefgh', 'server')
    const purged = version('purged', 'server', { purged: true })
    const missing = version('missing', 'server')
    const server = fakeServer({ '12345678': '12345678', abcdefgh: 'abcdefgh' })
    const outcomes = await run(
      'server-to-connector',
      [fits, overQuota, purged, missing],
      store,
      server.port,
    )
    const by = byId(outcomes)
    expect(by[fits.version_id]).toMatchObject({
      outcome: 'moved',
      location: 'connector',
    })
    expect(by[overQuota.version_id]).toMatchObject({
      outcome: 'stays',
      location: 'server',
      reason: 'quota-exceeded',
    })
    expect(by[purged.version_id]).toMatchObject({
      outcome: 'stays',
      reason: 'purged',
    })
    expect(by[missing.version_id]).toMatchObject({
      outcome: 'stays',
      reason: 'not-found',
    })
    const summary = summarizeMigration(outcomes)
    expect(summary).toMatchObject({ moved: 1, stays: 3 })
    expect(summary.messages).toContain(
      `Versão ${overQuota.version_id} permanece no servidor: a cota da biblioteca no destino foi excedida.`,
    )
  })

  test('a full disk keeps the version on the server', async () => {
    const { store } = await open(undefined, async () => 3)
    const big = version('too-big-for-disk', 'server')
    const outcomes = await run(
      'server-to-connector',
      [big],
      store,
      fakeServer({ x: 'too-big-for-disk' }).port,
    )
    expect(outcomes[0]).toMatchObject({
      outcome: 'stays',
      location: 'server',
      reason: 'disk-full',
    })
  })
})

describe('Connector to server', () => {
  test('sends verified bytes, then frees the Connector copy; the result says the files are on the server', async () => {
    const { store, directory } = await open()
    await store.put(bytes('print-me'))
    const v = version('print-me', 'connector')
    const server = fakeServer()
    const outcomes = await run('connector-to-server', [v], store, server.port)
    expect(outcomes).toEqual([
      {
        version_id: v.version_id,
        sha256: v.sha256,
        location: 'server',
        outcome: 'moved',
      },
    ])
    expect(server.received.get(v.sha256)).toBe('print-me')
    expect(await stored(directory)).toEqual([])
  })

  test('a corrupt Connector file is never sent and stays, reported as such', async () => {
    const { store, directory } = await open()
    const { sha256 } = await store.put(bytes('print-me'))
    await writeFile(join(directory, sha256), 'corrupted')
    const server = fakeServer()
    const outcomes = await run(
      'connector-to-server',
      [version('print-me', 'connector')],
      store,
      server.port,
    )
    expect(outcomes[0]).toMatchObject({
      outcome: 'stays',
      location: 'connector',
      reason: 'hash-mismatch',
    })
    expect(server.pushed).toEqual([])
    expect(await stored(directory)).toEqual([sha256])
  })

  test('an unconfirmed transfer keeps the Connector copy and is never retried automatically', async () => {
    const { store, directory } = await open()
    await store.put(bytes('print-me'))
    const server = fakeServer()
    server.options.failPush = true
    const v = version('print-me', 'connector')
    const outcomes = await run('connector-to-server', [v], store, server.port)
    expect(outcomes[0]).toMatchObject({
      outcome: 'stays',
      location: 'connector',
      reason: 'transfer-uncertain',
    })
    expect(server.pushed).toEqual([v.sha256]) // exactly one attempt
    expect(await stored(directory)).toEqual([v.sha256])
    expect(summarizeMigration(outcomes).messages[0]).toMatch(
      /nada foi repetido automaticamente/,
    )
  })

  test('a file already missing on the Connector stays with a not-found reason', async () => {
    const { store } = await open()
    const outcomes = await run(
      'connector-to-server',
      [version('lost', 'connector')],
      store,
      fakeServer().port,
    )
    expect(outcomes[0]).toMatchObject({
      outcome: 'stays',
      location: 'connector',
      reason: 'not-found',
    })
  })
})

describe('round trip', () => {
  test('server -> Connector -> server -> Connector keeps every version replayable', async () => {
    const { store } = await open()
    const v = version('round-trip', 'server')
    const server = fakeServer({ r: 'round-trip' })
    expect(
      (await run('server-to-connector', [v], store, server.port))[0]?.outcome,
    ).toBe('moved')
    expect((await store.openForPrint(v.sha256)).size).toBe(10)
    const onConnector = { ...v, location: 'connector' as const }
    expect(
      (await run('connector-to-server', [onConnector], store, server.port))[0]
        ?.outcome,
    ).toBe('moved')
    expect(await store.has(v.sha256)).toBe(false)
    expect(
      (await run('server-to-connector', [v], store, server.port))[0]?.outcome,
    ).toBe('moved')
    expect((await store.openForPrint(v.sha256)).sha256).toBe(v.sha256)
  })
})
