import { expect, test } from 'bun:test'
import {
  createFarmView,
  FarmAssignmentPage,
  FarmDiscoveryPage,
  localInterfaceOrigin,
  observationAge,
  type FarmAdmittedSession,
  type FarmAssignment,
  type FarmSnapshot,
  type FarmStatusFeed,
  type FarmViewState,
} from '../../apps/farm/app/utils/farm-view.ts'

const farm = '00000000-0000-4000-8000-000000000001'
const agent = '00000000-0000-4000-8000-000000000002'
const assignment = '00000000-0000-4000-8000-000000000003'
const keyId = '00000000-0000-4000-8000-000000000004'
const other = '00000000-0000-4000-8000-000000000005'
const thumbprint = 'A'.repeat(43)
const row: FarmAssignment = {
  assignmentId: assignment,
  agentId: agent,
  printerKey: ' e\u0301/打印机\n ',
  status: 'active',
  connectorStatus: 'approved',
}
const limits = {
  pendingLifetimeMs: 86_400_000,
  proofLifetimeMs: 60_000,
  maxChallengesPerKey: 3,
}
const device = {
  keyId,
  accountId: 'account-one',
  thumbprint,
  status: 'approved',
  proofAt: 10,
  createdAt: 0,
  pendingExpiresAt: null,
}
type FeedInput = Parameters<FarmStatusFeed['open']>[0]
type Read = Parameters<typeof createFarmView>[0]['read']
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('Not initialized')
  }
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function setup(feedEnabled = false) {
  const result: { state: FarmViewState } = { state: { kind: 'loading' } }
  const time = { wall: 100_000, mono: 1000 }
  const requests: {
    path: string
    signal: AbortSignal
    query: Record<string, string | number> | undefined
  }[] = []
  const peers: { input: FeedInput; closed: number }[] = []
  const data = {
    accountId: 'account-one',
    farms: { farms: [{ farmId: farm }], nextAfter: null as string | null },
    printers: {
      printers: [row],
      nextAfter: null as string | null,
      canManage: true,
    },
    devices: [{ ...device }],
    local: [{ thumbprint }],
  }
  const hooks: { read: Read | null; localError: boolean } = {
    read: null,
    localError: false,
  }
  const baseRead: Read = async (path) => {
    if (path === '/api/auth/me') return { accountId: data.accountId }
    if (path === '/api/farms') return data.farms
    if (path === `/api/farms/${farm}/printers`) return data.printers
    if (path === '/api/browser-devices')
      return {
        currentAccountId: data.accountId,
        currentRole: 'owner',
        devices: data.devices,
        nextAfter: null,
        limits,
      }
    throw new Error(`Unexpected request: ${path}`)
  }
  const view = createFarmView({
    read: (path, signal, query) => {
      requests.push({ path, signal, query })
      return (hooks.read ?? baseRead)(path, signal, query)
    },
    listKeys: async () => {
      if (hooks.localError) throw new Error('unavailable')
      return data.local
    },
    clock: () => ({ ...time }),
    changed: (state) => {
      result.state = state
    },
    ...(feedEnabled
      ? {
          feed: {
            open(input: FeedInput) {
              const peer = { input, closed: 0 }
              peers.push(peer)
              return {
                close: () => {
                  peer.closed++
                },
              }
            },
          },
        }
      : {}),
  })
  function ready() {
    if (result.state.kind !== 'ready')
      throw new Error(`Expected ready, got ${result.state.kind}`)
    return result.state
  }
  function first() {
    const first = ready().rows[0]
    if (!first) throw new Error('Expected row')
    return first
  }
  function peer(index = 0) {
    const peer = peers[index]
    if (!peer) throw new Error('Expected peer')
    return peer
  }
  const session: FarmAdmittedSession = {
    transportId: 'synthetic-test-transport',
    peerGeneration: 1,
    accountId: 'account-one',
    farmId: farm,
    agentId: agent,
    browserKeyId: keyId,
    expiresAt: 130_000,
    deadlineMonoMs: 31_000,
  }
  function authenticate(index = 0, admission = session) {
    peer(index).input.onHealth({
      kind: 'authenticated',
      session: { ...admission },
    })
  }
  function frame(
    seq = 0,
    printers = [
      {
        printerKey: row.printerKey,
        state: 'printing' as const,
        progress: 0.5,
        observedAt: time.wall,
      },
    ],
    changes: Partial<FarmSnapshot> = {},
  ) {
    const snapshot: FarmSnapshot = {
      session: { ...session },
      message: { t: 'snapshot', seq, printers },
      receivedAtWallMs: time.wall,
      receivedAtMonoMs: time.mono,
      sourceClockComparable: true,
      complete: true,
      ...changes,
    }
    peer().input.onSnapshot(snapshot)
  }
  return {
    result,
    time,
    requests,
    peers,
    data,
    hooks,
    baseRead,
    view,
    ready,
    first,
    peer,
    session,
    authenticate,
    frame,
  }
}

test('strict inventory decoders preserve exact opaque keys and reject added status/URL metadata', () => {
  expect(
    FarmAssignmentPage.parse({
      printers: [row],
      nextAfter: null,
      canManage: true,
    }).printers[0]?.printerKey,
  ).toBe(row.printerKey)
  for (const invalid of [
    { ...row, printerUrl: 'http://localhost' },
    { ...row, printerKey: '\ud800' },
    { ...row, printerKey: 'a\0b' },
    { ...row, connectorStatus: 'connected' },
  ]) {
    expect(
      FarmAssignmentPage.safeParse({
        printers: [invalid],
        nextAfter: null,
        canManage: true,
      }).success,
    ).toBe(false)
  }
  expect(
    FarmAssignmentPage.safeParse({
      printers: [row, row],
      nextAfter: null,
      canManage: true,
    }).success,
  ).toBe(false)
  expect(
    FarmDiscoveryPage.safeParse({
      farms: [{ farmId: farm, name: 'Invented' }],
      nextAfter: null,
    }).success,
  ).toBe(false)
})

test('real HTTP paths bracket identity and assignments remain readable without any feed', async () => {
  const h = setup()
  await h.view.discover()
  expect(h.requests.map(({ path }) => path)).toEqual([
    '/api/auth/me',
    '/api/farms',
    '/api/auth/me',
    '/api/auth/me',
    `/api/farms/${farm}/printers`,
    '/api/auth/me',
    '/api/browser-devices',
    '/api/auth/me',
  ])
  expect(h.first()).toEqual({
    assignment: row,
    connection: 'unavailable',
    observation: null,
    localOrigin: null,
  })
  expect(h.ready().keys).toEqual({
    kind: 'available',
    choices: [{ keyId, thumbprint }],
    selected: keyId,
  })
  expect(h.peers).toHaveLength(0)
  h.view.dispose()
})

test('no farms, no assignments, loading, and HTTP/schema failures are separate outcomes', async () => {
  const empty = setup()
  empty.data.farms.farms = []
  await empty.view.discover()
  expect(empty.ready().scope).toBeNull()
  expect(empty.ready().farms).toEqual([])
  const noRows = setup()
  noRows.data.printers.printers = []
  await noRows.view.discover()
  expect(noRows.ready().inventory).toBe('ready')
  expect(noRows.ready().rows).toEqual([])
  for (const [status, expected] of [
    [401, 'sign-in-required'],
    [403, 'error'],
    [429, 'error'],
    [503, 'error'],
  ] as const) {
    const h = setup()
    h.hooks.read = async () => {
      throw { statusCode: status }
    }
    const pending = h.view.discover()
    expect(h.result.state.kind).toBe('loading')
    await pending
    expect(h.result.state.kind).toBe(expected)
    if (h.result.state.kind === 'error')
      expect(h.result.state.reason).toBe(
        status === 403
          ? 'forbidden'
          : status === 429
            ? 'rate-limit'
            : 'unavailable',
      )
  }
  const invalid = setup()
  invalid.hooks.read = async () => ({
    accountId: 'account-one',
    unwanted: true,
  })
  await invalid.view.discover()
  expect(invalid.result.state).toEqual({
    kind: 'error',
    reason: 'invalid-response',
  })
})

test('farm pagination replaces the page, never auto-selects a partial result, and validates selection', async () => {
  const h = setup()
  h.data.farms.nextAfter = other
  await h.view.discover()
  expect(h.ready().scope).toBeNull()
  await h.view.selectFarm(other)
  expect(h.ready().scope).toBeNull()
  h.hooks.read = async (path, signal, query) =>
    path === '/api/farms' && query?.after === other
      ? { farms: [{ farmId: other }], nextAfter: null }
      : h.baseRead(path, signal, query)
  await h.view.discover(other)
  expect(h.ready().farms).toEqual([{ farmId: other }])
  expect(h.ready().scope).toBeNull()
  expect(h.ready().farmAfter).toBe(other)
})

test('late aborted HTTP results and prior errors cannot replace a newer account view', async () => {
  const h = setup(),
    old = deferred<unknown>()
  h.hooks.read = (path, signal, query) =>
    path === '/api/farms' ? old.promise : h.baseRead(path, signal, query)
  const first = h.view.discover()
  await Promise.resolve()
  await Promise.resolve()
  h.view.invalidate()
  expect(h.result.state).toEqual({ kind: 'loading' })
  h.hooks.read = null
  h.data.accountId = 'account-two'
  h.data.farms.farms = []
  await h.view.discover()
  old.resolve({ farms: [{ farmId: farm }], nextAfter: null })
  await first
  expect(h.ready().accountId).toBe('account-two')
  expect(h.ready().farms).toEqual([])
  expect(h.requests[0]?.signal.aborted).toBe(true)
})

test('observed account change after inventory clears private rows and links', async () => {
  const h = setup()
  await h.view.discover()
  expect(h.view.confirmOrigin(assignment, 'http://localhost:7125', true)).toBe(
    true,
  )
  h.hooks.read = async (path, signal, query) => {
    if (path.endsWith('/printers')) h.data.accountId = 'account-two'
    return h.baseRead(path, signal, query)
  }
  await h.view.selectFarm(farm)
  expect(h.result.state).toEqual({ kind: 'error', reason: 'account-changed' })
})

test('all registry pages are joined to current account/local thumbprints before selecting', async () => {
  const h = setup()
  h.hooks.read = async (path, signal, query) =>
    path === '/api/browser-devices'
      ? {
          currentAccountId: 'account-one',
          currentRole: 'owner',
          devices: query?.after ? [device] : [],
          nextAfter: query?.after ? null : other,
          limits,
        }
      : h.baseRead(path, signal, query)
  await h.view.discover()
  expect(h.ready().keys.kind).toBe('available')
  expect(
    h.requests
      .filter(({ path }) => path === '/api/browser-devices')
      .map(({ query }) => query?.after),
  ).toEqual([undefined, other])
  const many = setup(true)
  many.data.devices.push({ ...device, keyId: other })
  await many.view.discover()
  expect(many.ready().keys).toEqual({
    kind: 'available',
    choices: [
      { keyId, thumbprint },
      { keyId: other, thumbprint },
    ],
    selected: '',
  })
  expect(many.peers).toHaveLength(0)
  many.view.selectKey(other)
  expect(many.peer().input.browserKeyId).toBe(other)
})

test('inaccessible, pending, revoked, wrong-account, or incomplete registry never creates or substitutes keys', async () => {
  for (const status of ['pending', 'revoked'] as const) {
    const h = setup(true)
    h.hooks.read = async (path, signal, query) =>
      path === '/api/browser-devices'
        ? {
            currentAccountId: 'account-one',
            currentRole: 'owner',
            devices: [{ ...device, status }],
            nextAfter: null,
            limits,
          }
        : h.baseRead(path, signal, query)
    await h.view.discover()
    expect(h.ready().keys).toEqual({ kind: 'unavailable', reason: status })
    expect(h.peers).toHaveLength(0)
  }
  const storage = setup(true)
  storage.hooks.localError = true
  await storage.view.discover()
  expect(storage.ready().keys).toEqual({
    kind: 'unavailable',
    reason: 'storage',
  })
  expect(storage.first().assignment).toEqual(row)
  const wrong = setup(true)
  wrong.data.devices[0] = { ...device, accountId: 'account-two' }
  await wrong.view.discover()
  expect(wrong.ready().keys).toEqual({ kind: 'unavailable', reason: 'missing' })
  const mismatch = setup(true)
  mismatch.hooks.read = async (path, signal, query) =>
    path === '/api/browser-devices'
      ? {
          currentAccountId: 'account-two',
          currentRole: 'owner',
          devices: [],
          nextAfter: null,
          limits,
        }
      : mismatch.baseRead(path, signal, query)
  await mismatch.view.discover()
  expect(mismatch.result.state).toEqual({
    kind: 'error',
    reason: 'account-changed',
  })
})

test('one read-only feed per eligible Connector; revoked and pending assignments never subscribe', async () => {
  const h = setup(true)
  h.data.printers.printers.push(
    { ...row, assignmentId: other, printerKey: 'second' },
    { ...row, assignmentId: keyId, status: 'revoked' },
  )
  await h.view.discover()
  expect(h.peers).toHaveLength(1)
  expect(h.peer().input.assignmentRefs.map((ref) => ref.assignmentId)).toEqual([
    assignment,
    other,
  ])
  expect(h.first().connection).toBe('connecting')
  expect(h.first().observation).toBeNull()
  h.authenticate()
  expect(h.first().connection).toBe('authenticated')
  expect(h.first().observation).toBeNull()
  h.frame()
  expect(h.first().observation?.state.state).toBe('printing')
  expect(
    h.ready().rows.find((item) => item.assignment.assignmentId === keyId)
      ?.observation,
  ).toBeNull()
})

test('duplicates and older sequence numbers do not refresh receipt age; missing rows become historical', async () => {
  const h = setup(true)
  await h.view.discover()
  h.authenticate()
  h.frame(2)
  h.time.wall += 1000
  h.time.mono += 1000
  h.frame(2)
  h.frame(1)
  expect(h.first().observation?.received.wall).toBe(100_000)
  h.frame(3, [
    {
      printerKey: 'unassigned',
      state: 'printing',
      progress: 0.5,
      observedAt: h.time.wall,
    },
  ])
  expect(h.ready().rows).toHaveLength(1)
  expect(h.first().observation?.historical).toBe(true)
  expect(h.first().observation?.received.wall).toBe(100_000)
})

test('newer frames cannot roll back source time or change content at an equal source timestamp', async () => {
  const h = setup(true)
  await h.view.discover()
  h.authenticate()
  h.frame(1)
  h.time.wall += 1000
  h.time.mono += 1000
  h.frame(2, [
    {
      printerKey: row.printerKey,
      state: 'printing',
      progress: 0.7,
      observedAt: 99_999,
    },
  ])
  expect(h.first().observation?.state.progress).toBe(0.5)
  expect(h.first().observation?.historical).toBe(true)
  h.frame(3, [
    {
      printerKey: row.printerKey,
      state: 'printing',
      progress: 0.8,
      observedAt: 100_000,
    },
  ])
  expect(h.first().observation?.state.progress).toBe(0.5)
  expect(h.first().observation?.received.wall).toBe(100_000)
})

test('age uses monotonic receipt time, inclusive 30s staleness, old sources, and uncertain clocks', async () => {
  const h = setup(true)
  await h.view.discover()
  h.authenticate()
  h.frame()
  const observation = h.first().observation
  if (!observation) throw new Error('Expected observation')
  expect(observationAge(observation, { wall: 129_999, mono: 30_999 })).toEqual({
    seconds: 29,
    sourceConfirmed: true,
    stale: false,
  })
  expect(observationAge(observation, { wall: 130_000, mono: 31_000 })).toEqual({
    seconds: 30,
    sourceConfirmed: true,
    stale: true,
  })
  expect(
    observationAge(observation, { wall: 200_000, mono: 2000 }).sourceConfirmed,
  ).toBe(false)
  expect(
    observationAge(observation, { wall: 99_000, mono: 0 }).seconds,
  ).toBeNull()
  h.frame(1, [
    {
      printerKey: row.printerKey,
      state: 'printing',
      progress: 0.5,
      observedAt: 130_000,
    },
  ])
  const future = h.first().observation
  if (!future) throw new Error('Expected future observation')
  expect(observationAge(future, h.time).sourceConfirmed).toBe(false)
  const old = {
    ...observation,
    state: { ...observation.state, observedAt: 60_000 },
  }
  expect(observationAge(old, h.time).stale).toBe(true)
})

test('terminal disconnect/expiry rejects all late health and frames and never extends a lease', async () => {
  for (const expired of [false, true]) {
    const h = setup(true)
    await h.view.discover()
    h.authenticate()
    h.frame()
    if (expired) {
      h.time.wall = 130_000
      h.time.mono = 31_000
      h.view.tick()
    } else h.peer().input.onHealth({ kind: 'closed', reason: 'disconnected' })
    expect(h.first().connection).toBe('closed')
    expect(h.first().observation?.historical).toBe(true)
    h.authenticate()
    h.frame(99)
    expect(h.first().connection).toBe('closed')
    expect(h.first().observation?.received.wall).toBe(100_000)
    expect(h.peer().closed).toBe(1)
  }
  const renewal = setup(true)
  await renewal.view.discover()
  renewal.authenticate()
  renewal.authenticate(0, { ...renewal.session, expiresAt: 129_000 })
  expect(renewal.first().connection).toBe('closed')
})

test('wrong scope, generation, unsafe values, duplicate keys, and oversize frames fail closed', async () => {
  const cases: ((h: ReturnType<typeof setup>) => void)[] = [
    (h) => h.frame(1, undefined, { session: { ...h.session, farmId: other } }),
    (h) =>
      h.frame(1, undefined, { session: { ...h.session, peerGeneration: 2 } }),
    (h) => h.frame(Number.MAX_SAFE_INTEGER + 1),
    (h) =>
      h.frame(1, [
        {
          printerKey: row.printerKey,
          state: 'printing',
          progress: 0.5,
          observedAt: Number.MAX_SAFE_INTEGER + 1,
        },
      ]),
    (h) =>
      h.frame(1, [
        {
          printerKey: row.printerKey,
          state: 'printing',
          progress: 0.5,
          observedAt: 100_000,
        },
        {
          printerKey: row.printerKey,
          state: 'printing',
          progress: 0.5,
          observedAt: 100_000,
        },
      ]),
    (h) =>
      h.frame(
        1,
        Array.from({ length: 30 }, (_, n) => ({
          printerKey: `test-${n}-${'x'.repeat(100)}`,
          state: 'printing',
          progress: 0.5,
          observedAt: 100_000,
        })),
      ),
  ]
  for (const invalid of cases) {
    const h = setup(true)
    await h.view.discover()
    h.authenticate()
    invalid(h)
    expect(h.first().connection).toBe('closed')
    expect(h.first().observation).toBeNull()
  }
})

test('farm/key/page invalidation aborts and closes peers; old assignment callbacks cannot populate replacement', async () => {
  const h = setup(true)
  await h.view.discover()
  h.authenticate()
  h.frame()
  const old = h.peer()
  h.view.confirmOrigin(assignment, 'http://localhost', true)
  h.data.printers.printers = [{ ...row, assignmentId: other }]
  await h.view.selectFarm(farm, assignment)
  old.input.onHealth({ kind: 'authenticated', session: h.session })
  old.input.onSnapshot({
    session: h.session,
    message: {
      t: 'snapshot',
      seq: 99,
      printers: [
        {
          printerKey: row.printerKey,
          state: 'idle',
          progress: 0,
          observedAt: 100_000,
        },
      ],
    },
    receivedAtWallMs: 100_000,
    receivedAtMonoMs: 1000,
    sourceClockComparable: true,
    complete: true,
  })
  expect(old.closed).toBe(1)
  expect(old.input.signal.aborted).toBe(true)
  expect(h.first().assignment.assignmentId).toBe(other)
  expect(h.first().observation).toBeNull()
  expect(h.first().localOrigin).toBeNull()
  h.view.selectKey('')
  expect(h.peer(1).closed).toBe(1)
  h.view.dispose()
  expect(h.result.state).toEqual({ kind: 'loading' })
})

test('explicit local origin confirmation is memory-only, does no read, and clears on scope uncertainty', async () => {
  const h = setup()
  await h.view.discover()
  const reads = h.requests.length
  expect(h.view.confirmOrigin(assignment, 'HTTP://LOCALHOST:80/', false)).toBe(
    false,
  )
  expect(h.view.confirmOrigin(assignment, 'HTTP://LOCALHOST:80/', true)).toBe(
    true,
  )
  expect(h.first().localOrigin).toBe('http://localhost')
  expect(h.requests).toHaveLength(reads)
  h.view.invalidate()
  expect(h.result.state).toEqual({ kind: 'loading' })
  await h.view.discover()
  expect(h.first().localOrigin).toBeNull()
})

test('local origin policy permits deliberate local DNS/IP/loopback and rejects URL normalization tricks', () => {
  for (const [input, origin] of [
    ['http://printer.local', 'http://printer.local'],
    ['https://192.168.1.5:8443/', 'https://192.168.1.5:8443'],
    ['http://[::1]:80', 'http://[::1]'],
  ] as const)
    expect(localInterfaceOrigin(input ?? '')).toBe(origin)
  for (const input of [
    'javascript:alert(1)',
    '//printer.local',
    'http://user:pass@printer.local',
    'http://@printer.local',
    'http://printer.local/path',
    'http://printer.local/a/..',
    'http://printer.local/%2e',
    'http://printer.local?',
    'http://printer.local#',
    'http://printer.local?pause=1',
    'http://printer.local\\evil',
    'http://printer.local:99999',
    ' http://printer.local',
    'http://printer.local\n',
    'http://printer.local\u0000',
  ])
    expect(localInterfaceOrigin(input)).toBeNull()
})

test('late local-key enumeration cannot repopulate an invalidated view', async () => {
  const pending = deferred<readonly { thumbprint: string }[]>()
  const result: { state: FarmViewState } = { state: { kind: 'loading' } }
  const h = setup()
  const view = createFarmView({
    read: h.baseRead,
    listKeys: () => pending.promise,
    clock: () => h.time,
    changed: (state) => {
      result.state = state
    },
  })
  const loading = view.discover()
  for (let turn = 0; turn < 20; turn++) await Promise.resolve()
  expect(result.state.kind).toBe('ready')
  view.invalidate()
  pending.resolve([{ thumbprint }])
  await loading
  expect(result.state).toEqual({ kind: 'loading' })
})

test('registry authorization errors clear inventory while a registry outage leaves inventory readable', async () => {
  for (const status of [401, 403, 503]) {
    const h = setup(true)
    h.hooks.read = async (path, signal, query) => {
      if (path === '/api/browser-devices') throw { status }
      return h.baseRead(path, signal, query)
    }
    await h.view.discover()
    expect(h.peers).toHaveLength(0)
    if (status === 503) {
      expect(h.first().assignment).toEqual(row)
      expect(h.ready().keys).toEqual({
        kind: 'unavailable',
        reason: 'registry',
      })
    } else
      expect(h.result.state.kind).toBe(
        status === 401 ? 'sign-in-required' : 'error',
      )
  }
})

test('bounded registry scan does not claim that an unseen later key is missing', async () => {
  const h = setup(true)
  let page = 0
  h.hooks.read = async (path, signal, query) =>
    path === '/api/browser-devices'
      ? {
          currentAccountId: 'account-one',
          currentRole: 'owner',
          devices: [],
          nextAfter: `00000000-0000-4000-8000-${String(++page).padStart(12, '0')}`,
          limits,
        }
      : h.baseRead(path, signal, query)
  await h.view.discover()
  expect(page).toBe(32)
  expect(h.ready().keys).toEqual({ kind: 'unavailable', reason: 'incomplete' })
  expect(h.peers).toHaveLength(0)
})

test('another printer never refreshes the first row; equal source data cannot conceal an old observation', async () => {
  const h = setup(true)
  h.data.printers.printers.push({
    ...row,
    assignmentId: other,
    printerKey: 'second',
  })
  await h.view.discover()
  h.authenticate()
  h.frame(1)
  h.time.wall += 1000
  h.time.mono += 1000
  h.frame(2, [
    {
      printerKey: 'second',
      state: 'printing',
      progress: 0.25,
      observedAt: h.time.wall,
    },
  ])
  expect(h.first().observation?.received.wall).toBe(100_000)
  expect(h.ready().rows[1]?.observation?.received.wall).toBe(101_000)
  const old = setup(true)
  await old.view.discover()
  old.authenticate()
  old.frame(1, [
    {
      printerKey: row.printerKey,
      state: 'printing',
      progress: 0.5,
      observedAt: 60_000,
    },
  ])
  old.time.wall += 1000
  old.time.mono += 1000
  old.frame(2, [
    {
      printerKey: row.printerKey,
      state: 'printing',
      progress: 0.5,
      observedAt: 60_000,
    },
  ])
  const observation = old.first().observation
  if (!observation) throw new Error('Expected observation')
  expect(observationAge(observation, old.time).stale).toBe(true)
})

test('frames before admission, overlong leases, wrong key admission, and clock regression fail closed', async () => {
  const early = setup(true)
  await early.view.discover()
  early.frame()
  expect(early.first().observation).toBeNull()
  for (const modify of [
    (session: FarmAdmittedSession) => ({ ...session, expiresAt: 130_001 }),
    (session: FarmAdmittedSession) => ({ ...session, deadlineMonoMs: 31_001 }),
    (session: FarmAdmittedSession) => ({ ...session, browserKeyId: other }),
    (session: FarmAdmittedSession) => ({
      ...session,
      accountId: 'account-two',
    }),
  ]) {
    const h = setup(true)
    await h.view.discover()
    h.authenticate(0, modify(h.session))
    expect(h.first().connection).toBe('closed')
  }
  const regressed = setup(true)
  await regressed.view.discover()
  regressed.authenticate()
  regressed.frame()
  regressed.time.mono = 999
  regressed.view.tick()
  expect(regressed.first().connection).toBe('closed')
  expect(regressed.first().observation?.historical).toBe(true)
})

test('revoked rows and Connector revocation cannot retain an old observation or local origin', async () => {
  for (const revoked of [
    { ...row, status: 'revoked' as const },
    { ...row, connectorStatus: 'revoked' as const },
  ]) {
    const h = setup(true)
    await h.view.discover()
    h.authenticate()
    h.frame()
    h.view.confirmOrigin(assignment, 'http://localhost', true)
    h.data.printers.printers = [revoked]
    await h.view.selectFarm(farm)
    expect(h.peers).toHaveLength(1)
    expect(h.peer().closed).toBe(1)
    expect(h.first().observation).toBeNull()
    expect(h.first().localOrigin).toBeNull()
    expect(h.view.confirmOrigin(assignment, 'http://localhost', true)).toBe(
      false,
    )
  }
})

test('producer teardown failure cannot prevent private state invalidation', async () => {
  const result: { state: FarmViewState } = { state: { kind: 'loading' } }
  const h = setup()
  const view = createFarmView({
    read: h.baseRead,
    listKeys: async () => [{ thumbprint }],
    clock: () => h.time,
    changed: (state) => {
      result.state = state
    },
    feed: {
      open() {
        return {
          close() {
            throw new Error('synthetic teardown error')
          },
        }
      },
    },
  })
  await view.discover()
  expect(() => view.invalidate()).not.toThrow()
  expect(result.state).toEqual({ kind: 'loading' })
})
