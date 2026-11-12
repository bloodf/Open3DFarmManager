import { expect, test, vi } from 'vitest'
import {
  completeAuth,
  listenForAuthInvalidation,
} from '../../apps/farm/app/utils/auth-invalidation.ts'
import {
  createFarmView,
  farmConnectionNotice,
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
function setup(feedEnabled = false, random?: () => number) {
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
  const hooks: { read: Read | null; localError: boolean; close?: () => void } =
    {
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
    ...(random ? { random } : {}),
    ...(feedEnabled
      ? {
          feed: {
            open(input: FeedInput) {
              const peer = { input, closed: 0 }
              peers.push(peer)
              return {
                close: () => {
                  peer.closed++
                  hooks.close?.()
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
    printers: FarmSnapshot['message']['printers'] = [
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
  await many.view.selectKey(other)
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
  h.frame(0, [
    {
      printerKey: row.printerKey,
      state: 'printing',
      progress: 0.5,
      observedAt: h.time.wall,
    },
    {
      printerKey: 'second',
      state: 'idle',
      progress: 0,
      observedAt: h.time.wall,
    },
  ])
  expect(h.first().observation?.state.state).toBe('printing')
  expect(
    h.ready().rows.find((item) => item.assignment.assignmentId === keyId)
      ?.observation,
  ).toBeNull()
})

test('duplicates do not refresh age; a non-complete printer set terminally retains history', async () => {
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
  await h.view.selectKey('')
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

test('partial printer updates refresh no rows; equal source data cannot conceal an old observation', async () => {
  const h = setup(true)
  h.data.printers.printers.push({
    ...row,
    assignmentId: other,
    printerKey: 'second',
  })
  await h.view.discover()
  h.authenticate()
  h.frame(1, [
    {
      printerKey: row.printerKey,
      state: 'printing',
      progress: 0.5,
      observedAt: h.time.wall,
    },
    {
      printerKey: 'second',
      state: 'printing',
      progress: 0.1,
      observedAt: h.time.wall,
    },
  ])
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
  expect(h.ready().rows[1]?.observation?.received.wall).toBe(100_000)
  expect(h.first().connection).toBe('closed')
  expect(h.ready().rows.every((row) => row.observation?.historical)).toBe(true)
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

test('reentrant producer teardown keeps only the winning key generation and owns its cleanup', async () => {
  for (const trigger of ['selection', 'terminal'] as const) {
    const h = setup(true)
    const keyB = other,
      keyC = '00000000-0000-4000-8000-000000000006'
    const thumbB = 'B'.repeat(42) + 'A',
      thumbC = 'C'.repeat(42) + 'A'
    h.data.devices.push(
      { ...device, keyId: keyB, thumbprint: thumbB },
      { ...device, keyId: keyC, thumbprint: thumbC },
    )
    h.data.local.push({ thumbprint: thumbB }, { thumbprint: thumbC })
    await h.view.discover()
    await h.view.selectKey(keyId)
    h.hooks.close = () => {
      delete h.hooks.close
      h.view.selectKey(keyC)
    }
    if (trigger === 'selection') await h.view.selectKey(keyB)
    else h.peer().input.onHealth({ kind: 'closed', reason: 'disconnected' })
    // Reentrant selection deliberately starts a new asynchronous complete scan.
    for (let step = 0; step < 50 && h.peers.length < 2; step++)
      await Promise.resolve()
    const keys = h.ready().keys
    expect(keys.kind).toBe('available')
    if (keys.kind === 'available') expect(keys.selected).toBe(keyC)
    expect(h.peers).toHaveLength(2)
    expect(h.peer(0).closed).toBe(1)
    expect(h.peer(1).closed).toBe(0)
    expect(h.first().connection).toBe('connecting')
    h.authenticate(1, { ...h.session, browserKeyId: keyC })
    expect(h.first().connection).toBe('authenticated')
    h.peer(0).input.onHealth({ kind: 'authenticated', session: h.session })
    expect(h.first().connection).toBe('authenticated')
    h.view.dispose()
    expect(h.peer(1).closed).toBe(1)
    expect(h.peer(1).input.signal.aborted).toBe(true)
  }
})

function installInventoryPages(
  h: ReturnType<typeof setup>,
  pages: {
    printers: FarmAssignment[]
    nextAfter: string | null
    canManage: boolean
  }[],
) {
  let reads = 0
  h.hooks.read = async (path, signal, query) => {
    if (path !== `/api/farms/${farm}/printers`)
      return h.baseRead(path, signal, query)
    if (reads++ === 0) return h.data.printers // Visible page remains independent.
    const index = query?.after
      ? pages.findIndex((page) => page.nextAfter === query.after) + 1
      : 0
    const page = pages[index]
    if (!page) throw Error('Unexpected inventory cursor')
    return page
  }
}
function inventoryPage(
  printers: FarmAssignment[],
  nextAfter: string | null = null,
) {
  return { printers, nextAfter, canManage: true }
}

test('complete scope crosses inventory pages without adding hidden rows to presentation', async () => {
  const h = setup(true)
  const hidden = { ...row, assignmentId: other, printerKey: 'hidden' }
  h.data.printers.nextAfter = assignment
  installInventoryPages(h, [
    inventoryPage([row], assignment),
    inventoryPage([hidden]),
  ])
  await h.view.discover()
  expect(h.ready().rows.map((value) => value.assignment.assignmentId)).toEqual([
    assignment,
  ])
  expect(h.ready().nextPrinter).toBe(assignment)
  expect(h.ready().feedScope).toBe('ready')
  expect(h.peer().input.assignmentRefs).toEqual([
    { assignmentId: assignment, agentId: agent, printerKey: row.printerKey },
    { assignmentId: other, agentId: agent, printerKey: 'hidden' },
  ])
  expect(Object.isFrozen(h.peer().input.assignmentRefs)).toBe(true)
  h.authenticate()
  h.frame(0, [
    {
      printerKey: row.printerKey,
      state: 'printing',
      progress: 0.5,
      observedAt: h.time.wall,
    },
    {
      printerKey: 'hidden',
      state: 'paused',
      progress: 0.7,
      observedAt: h.time.wall,
    },
  ])
  expect(h.ready().rows).toHaveLength(1)
  expect(h.first().observation?.state.state).toBe('printing')
  expect(
    h.requests
      .filter((request) => request.path.endsWith('/printers'))
      .map((request) => request.query),
  ).toEqual([{ limit: 20 }, { limit: 20 }, { limit: 20, after: assignment }])
  h.view.dispose()
})

test('only visible eligible agents open, with their complete distinct tuple sets', async () => {
  const h = setup(true)
  const visibleB = {
    ...row,
    assignmentId: other,
    agentId: keyId,
    printerKey: 'visible-b',
  }
  const hiddenA = {
    ...row,
    assignmentId: '00000000-0000-4000-8000-000000000006',
    printerKey: 'hidden-a',
  }
  const hiddenB = {
    ...row,
    assignmentId: '00000000-0000-4000-8000-000000000007',
    agentId: keyId,
    printerKey: 'hidden-b',
  }
  const hiddenC = {
    ...row,
    assignmentId: '00000000-0000-4000-8000-000000000008',
    agentId: other,
    printerKey: 'hidden-c',
  }
  h.data.printers.printers = [row, visibleB]
  installInventoryPages(h, [
    inventoryPage([row, visibleB], other),
    inventoryPage([hiddenA, hiddenB, hiddenC]),
  ])
  await h.view.discover()
  expect(h.peers).toHaveLength(2)
  expect(h.peer(0).input.assignmentRefs.map((ref) => ref.printerKey)).toEqual([
    row.printerKey,
    'hidden-a',
  ])
  expect(h.peer(1).input.assignmentRefs.map((ref) => ref.printerKey)).toEqual([
    'visible-b',
    'hidden-b',
  ])
  expect(h.peers.some((peer) => peer.input.agentId === other)).toBe(false)
  h.view.dispose()
})

test('cycle, duplicate, oversized and contradictory scope retain inventory and keys without feeds', async () => {
  const cases = [
    [
      inventoryPage([row], assignment),
      inventoryPage(
        [{ ...row, assignmentId: other, printerKey: 'other' }],
        assignment,
      ),
    ],
    [inventoryPage([row], assignment), inventoryPage([row])],
    [inventoryPage([{ ...row, printerKey: 'changed' }])],
    [inventoryPage([])],
    [
      inventoryPage(
        Array.from({ length: 21 }, (_, i) => ({
          ...row,
          assignmentId: `00000000-0000-4000-8000-${String(i + 20).padStart(12, '0')}`,
          printerKey: `key-${i}`,
        })),
      ),
    ],
    [
      inventoryPage([row], assignment),
      inventoryPage([
        {
          ...row,
          assignmentId: other,
          connectorStatus: 'revoked' as const,
          printerKey: 'changed',
        },
      ]),
    ],
  ]
  for (const pages of cases) {
    const h = setup(true)
    installInventoryPages(h, pages)
    await h.view.discover()
    expect(h.ready().inventory).toBe('ready')
    expect(h.first().assignment).toEqual(row)
    expect(h.ready().feedScope).toBe('unavailable')
    expect(h.ready().keys.kind).toBe('available')
    expect(h.peers).toHaveLength(0)
    h.view.dispose()
  }
})

test('32-page incomplete scan and over-cap complete Connector set do not open a split feed', async () => {
  for (const capacity of [false, true]) {
    const h = setup(true)
    let count = 0
    h.hooks.read = async (path, signal, query) => {
      if (!path.endsWith('/printers')) return h.baseRead(path, signal, query)
      if (count++ === 0) return h.data.printers
      if (capacity)
        return inventoryPage([
          row,
          ...Array.from({ length: 15 }, (_, i) => ({
            ...row,
            assignmentId: `00000000-0000-4000-8000-${String(i + 20).padStart(12, '0')}`,
            printerKey: `${i}${'界'.repeat(100)}`,
          })),
        ])
      const assignmentId = `00000000-0000-4000-8000-${String(count + 20).padStart(12, '0')}`
      return inventoryPage(
        count === 2
          ? [row]
          : [{ ...row, assignmentId, printerKey: `key-${count}` }],
        assignmentId,
      )
    }
    await h.view.discover()
    expect(h.ready().feedScope).toBe('unavailable')
    expect(h.peers).toHaveLength(0)
    expect(h.ready().rows).toHaveLength(1)
    expect(count).toBe(capacity ? 2 : 33)
    h.view.dispose()
  }
})

test('changed account during scope scan clears private inventory', async () => {
  const h = setup(true)
  let reads = 0
  h.hooks.read = async (path, signal, query) => {
    if (path.endsWith('/printers') && ++reads === 2) {
      h.data.accountId = 'account-two'
      return h.data.printers
    }
    return h.baseRead(path, signal, query)
  }
  await h.view.discover()
  expect(h.result.state).toEqual({ kind: 'error', reason: 'account-changed' })
  expect(h.peers).toHaveLength(0)
  h.view.dispose()
})

test('late scope scan after invalidate or key replacement cannot open or reuse old tuples', async () => {
  for (const action of ['invalidate', 'key'] as const) {
    const h = setup(true),
      pending = deferred<unknown>(),
      entered = deferred<void>()
    let reads = 0
    h.hooks.read = async (path, signal, query) => {
      if (path.endsWith('/printers') && ++reads === 2) {
        entered.resolve()
        return pending.promise
      }
      return h.baseRead(path, signal, query)
    }
    const old = h.view.discover()
    await entered.promise
    expect(h.ready().feedScope).toBe('loading')
    expect(h.peers).toHaveLength(0)
    if (action === 'invalidate') h.view.invalidate()
    else {
      await h.view.selectKey('')
      await h.view.selectKey(keyId)
    }
    pending.resolve(inventoryPage([{ ...row, printerKey: 'stale-hidden-key' }]))
    await old
    expect(h.peers).toHaveLength(action === 'invalidate' ? 0 : 1)
    if (action === 'key')
      expect(h.peer().input.assignmentRefs[0]?.printerKey).toBe(row.printerKey)
    else expect(h.result.state).toEqual({ kind: 'loading' })
    h.view.dispose()
  }
})

test('refresh rebuilds full scope and cannot replay the prior complete tuple cache', async () => {
  const h = setup(true)
  await h.view.discover()
  h.authenticate()
  h.frame()
  const old = h.peer()
  const hidden = { ...row, assignmentId: other, printerKey: 'new-hidden' }
  h.data.printers.nextAfter = assignment
  installInventoryPages(h, [
    inventoryPage([row], assignment),
    inventoryPage([hidden]),
  ])
  await h.view.selectFarm(farm)
  expect(old.closed).toBe(1)
  expect(old.input.signal.aborted).toBe(true)
  expect(h.peer(1).input.assignmentRefs.map((ref) => ref.printerKey)).toEqual([
    row.printerKey,
    'new-hidden',
  ])
  expect(h.first().observation).toBeNull()
  h.frame(9)
  expect(h.first().observation).toBeNull()
  installInventoryPages(h, [
    inventoryPage([row], assignment),
    inventoryPage([{ ...hidden, status: 'revoked' }]),
  ])
  await h.view.selectFarm(farm)
  expect(h.peer(1).closed).toBe(1)
  expect(h.peer(2).input.assignmentRefs.map((ref) => ref.printerKey)).toEqual([
    row.printerKey,
  ])
  h.view.dispose()
})

test('auth success notifies the same window and another tab before navigation; failure stays silent', async () => {
  const channels = new Set<FakeChannel>()
  const messages: unknown[] = []
  class FakeChannel {
    onmessage: ((event: { data: unknown }) => void) | null = null
    constructor(readonly name: string) {
      channels.add(this)
    }
    postMessage(data: unknown) {
      messages.push(data)
      for (const channel of channels)
        if (channel !== this && channel.name === this.name)
          channel.onmessage?.({ data })
    }
    close() {
      channels.delete(this)
    }
  }
  const localWindow = new EventTarget()
  const remoteWindow = new EventTarget()
  vi.stubGlobal('BroadcastChannel', FakeChannel)
  vi.stubGlobal('window', remoteWindow)
  const remote = vi.fn()
  const stopRemote = listenForAuthInvalidation(remote)
  vi.stubGlobal('window', localWindow)
  const local = vi.fn()
  const stopLocal = listenForAuthInvalidation(local)
  try {
    const request = deferred<unknown>()
    const navigation = vi.fn()
    const pending = completeAuth(() => request.promise).then(() => {
      expect(local).toHaveBeenCalled()
      expect(remote).toHaveBeenCalledOnce()
      navigation()
    })
    expect(local).not.toHaveBeenCalled()
    expect(remote).not.toHaveBeenCalled()
    expect(navigation).not.toHaveBeenCalled()
    request.resolve({ ok: true, accountId: 'private-account' })
    await pending
    expect(navigation).toHaveBeenCalledOnce()
    expect(messages).toEqual([null])
    const count = local.mock.calls.length
    await expect(
      completeAuth(async () => {
        throw new Error('auth failed')
      }),
    ).rejects.toThrow('auth failed')
    expect(local).toHaveBeenCalledTimes(count)
    expect(remote).toHaveBeenCalledOnce()
    localWindow.dispatchEvent(new Event('open3dfarmmanager:auth-invalidated'))
    expect(local).toHaveBeenCalledTimes(count + 1)
    stopLocal()
    vi.stubGlobal('window', remoteWindow)
    stopRemote()
    expect(channels.size).toBe(0)
    localWindow.dispatchEvent(new Event('open3dfarmmanager:auth-invalidated'))
    remoteWindow.dispatchEvent(new Event('open3dfarmmanager:auth-invalidated'))
    expect(local).toHaveBeenCalledTimes(count + 1)
    expect(remote).toHaveBeenCalledOnce()
  } finally {
    vi.stubGlobal('window', localWindow)
    stopLocal()
    vi.stubGlobal('window', remoteWindow)
    stopRemote()
    vi.unstubAllGlobals()
  }
})

test.each(['unavailable', 'constructor', 'post', 'close'] as const)(
  'auth keeps local invalidation when BroadcastChannel fails at %s',
  async (failure) => {
    const closed = vi.fn()
    class BrokenChannel {
      onmessage = null
      constructor() {
        if (failure === 'constructor') throw new Error('unavailable')
      }
      postMessage() {
        if (failure === 'post') throw new Error('cannot post')
      }
      close() {
        closed()
        if (failure === 'close') throw new Error('cannot close')
      }
    }
    vi.stubGlobal('window', new EventTarget())
    vi.stubGlobal(
      'BroadcastChannel',
      failure === 'unavailable' ? undefined : BrokenChannel,
    )
    const invalidate = vi.fn()
    const stop = listenForAuthInvalidation(invalidate)
    try {
      await completeAuth(async () => ({}))
      expect(invalidate).toHaveBeenCalledOnce()
      stop()
      stop()
      await completeAuth(async () => ({}))
      expect(invalidate).toHaveBeenCalledOnce()
      if (failure === 'post' || failure === 'close')
        expect(closed).toHaveBeenCalledTimes(3)
    } finally {
      stop()
      vi.unstubAllGlobals()
    }
  },
)

test('auth invalidation aborts stale discovery while hidden and focus can rediscover', async () => {
  vi.stubGlobal('window', new EventTarget())
  vi.stubGlobal('BroadcastChannel', undefined)
  const h = setup()
  const stale = deferred<unknown>()
  let hidden = true
  h.hooks.read = () => stale.promise
  const loading = h.view.discover()
  const stop = listenForAuthInvalidation(() => {
    h.view.invalidate()
    if (!hidden) void h.view.discover()
  })
  try {
    await completeAuth(async () => ({}))
    expect(h.requests[0]?.signal.aborted).toBe(true)
    expect(h.requests).toHaveLength(1)
    stale.resolve({ accountId: 'stale-account' })
    await loading
    expect(h.result.state.kind).toBe('loading')
    hidden = false
    h.hooks.read = null
    await h.view.discover()
    expect(h.ready().accountId).toBe('account-one')
  } finally {
    stop()
    h.view.dispose()
    vi.unstubAllGlobals()
  }
})

test('admitted temperature readings reach farm rows, and missing readings remain unavailable', async () => {
  const h = setup(true)
  try {
    await h.view.discover()
    h.authenticate()
    h.frame(0, [
      {
        printerKey: row.printerKey,
        state: 'idle',
        progress: 0,
        observedAt: h.time.wall,
        toolTemperatureCelsius: 0,
        bedTemperatureCelsius: -3.5,
      },
    ])
    expect(h.first().observation?.state.toolTemperatureCelsius).toBe(0)
    expect(h.first().observation?.state.bedTemperatureCelsius).toBe(-3.5)
    expect(h.first().connection).toBe('authenticated')
    h.time.wall += 1
    h.time.mono += 1
    h.frame(1, [
      {
        printerKey: row.printerKey,
        state: 'idle',
        progress: 0,
        observedAt: h.time.wall,
      },
    ])
    expect(h.first().observation?.state.toolTemperatureCelsius).toBeUndefined()
    expect(h.first().observation?.state.bedTemperatureCelsius).toBeUndefined()
    expect(h.first().connection).toBe('authenticated')
  } finally {
    h.view.dispose()
  }
})

// Mirrors useFarmView: a 1 s interval advances the clock and ticks the view.
function liveClock(h: ReturnType<typeof setup>) {
  const interval = setInterval(() => {
    h.time.wall += 1000
    h.time.mono += 1000
    h.view.tick()
  }, 1000)
  return () => clearInterval(interval)
}
const second = (ms = 1000) => vi.advanceTimersByTimeAsync(ms)
function admit(h: ReturnType<typeof setup>, index: number, agentId = agent) {
  const session = {
    ...h.session,
    agentId,
    transportId: `synthetic-transport-${index}`,
    peerGeneration: index + 1,
    expiresAt: h.time.wall + 30_000,
    deadlineMonoMs: h.time.mono + 30_000,
  }
  h.peer(index).input.onHealth({ kind: 'authenticated', session })
  return session
}
function send(
  h: ReturnType<typeof setup>,
  index: number,
  session: FarmAdmittedSession,
  seq: number,
  printerKey = row.printerKey,
) {
  h.peer(index).input.onSnapshot({
    session: { ...session },
    message: {
      t: 'snapshot',
      seq,
      printers: [
        {
          printerKey,
          state: 'printing',
          progress: 0.5,
          observedAt: h.time.wall,
        },
      ],
    },
    receivedAtWallMs: h.time.wall,
    receivedAtMonoMs: h.time.mono,
    sourceClockComparable: true,
    complete: true,
  })
}
// Admit and stream frames for `seconds`, leaving the feed healthy (>=10 s of data).
async function stream(
  h: ReturnType<typeof setup>,
  index: number,
  seconds: number,
) {
  const session = admit(h, index)
  for (let at = 0; at < seconds; at++) {
    send(h, index, session, at)
    await second()
  }
  send(h, index, session, seconds)
  return session
}
async function fakeTimers<T>(
  h: ReturnType<typeof setup>,
  body: () => Promise<T>,
) {
  vi.useFakeTimers()
  const stop = liveClock(h)
  try {
    return await body()
  } finally {
    stop()
    h.view.dispose()
    vi.useRealTimers()
  }
}
// Waits up to `limit` ms of fake time for a new subscription; returns elapsed ms.
async function nextPeer(h: ReturnType<typeof setup>, limit = 60_000) {
  const count = h.peers.length,
    from = h.time.mono
  for (let at = 0; at < limit && h.peers.length === count; at += 1000)
    await second()
  return h.peers.length === count ? null : h.time.mono - from
}

test('silent P2P loss becomes read-only within 10 s, then a re-checked jittered reopen recovers', async () => {
  const h = setup(true, () => 0)
  await fakeTimers(h, async () => {
    await h.view.discover()
    await stream(h, 0, 10)
    expect(h.first().observation?.historical).toBe(false)
    const lost = h.time.mono
    let detected: number | null = null
    for (let at = 0; at < 10 && detected === null; at++) {
      await second()
      if (h.first().connection === 'closed') detected = h.time.mono - lost
    }
    expect(detected).not.toBeNull()
    expect(detected).toBeLessThanOrEqual(10_000)
    expect(h.first().observation?.historical).toBe(true)
    expect(farmConnectionNotice(h.ready().rows)).toContain('indisponível')
    const before = h.requests.length
    // Healthy feed: budget resets, 1 s * 2^0 * jitter 0.5.
    expect(await nextPeer(h)).toBeLessThanOrEqual(1000)
    // Identity and assignment authority are re-read before reopening.
    expect(h.requests.slice(before).map((request) => request.path)).toEqual([
      '/api/auth/me',
      `/api/farms/${farm}/printers`,
      '/api/auth/me',
    ])
    expect(h.first().connection).toBe('connecting')
    expect(h.first().observation?.historical).toBe(true)
    const session = admit(h, 1)
    send(h, 1, session, 0)
    expect(h.first().connection).toBe('authenticated')
    expect(h.first().observation?.historical).toBe(false)
  })
})

test('a healthy lease end renews seamlessly: rows stay live and the live region stays silent', async () => {
  const h = setup(true, () => 0)
  await fakeTimers(h, async () => {
    await h.view.discover()
    const session = admit(h, 0)
    const notices = new Set<string>()
    const requests = h.requests.length
    let seq = 0
    while (h.peers.length === 1) {
      send(h, 0, session, seq++)
      expect(h.first().connection).toBe('authenticated')
      expect(h.first().observation?.historical).toBe(false)
      notices.add(farmConnectionNotice(h.ready().rows))
      await second()
    }
    expect(h.time.mono - 1000).toBeGreaterThanOrEqual(30_000)
    expect(h.peer(0).closed).toBe(1)
    // The renewal neither re-reads HTTP nor surfaces transient steps.
    expect(h.requests.length).toBe(requests)
    h.peer(1).input.onHealth({ kind: 'connecting' })
    h.peer(1).input.onHealth({ kind: 'verifying' })
    expect(h.first().connection).toBe('authenticated')
    expect(h.first().observation?.historical).toBe(false)
    notices.add(farmConnectionNotice(h.ready().rows))
    const renewed = admit(h, 1)
    send(h, 1, renewed, 0)
    notices.add(farmConnectionNotice(h.ready().rows))
    expect(notices).toEqual(
      new Set([
        'Conexão direta autenticada. Os controles continuam em modo somente leitura.',
      ]),
    )
    expect(h.first().observation?.received.mono).toBe(h.time.mono)
  })
})

test('a renewal that never authenticates closes within 10 s of the last frame', async () => {
  const h = setup(true, () => 0)
  await fakeTimers(h, async () => {
    await h.view.discover()
    const session = admit(h, 0)
    let seq = 0,
      last = h.time.mono
    while (h.peers.length === 1) {
      send(h, 0, session, seq++)
      last = h.time.mono
      await second()
    }
    expect(h.first().connection).toBe('authenticated')
    while (h.first().connection === 'authenticated') await second()
    expect(h.time.mono - last).toBeLessThanOrEqual(10_000)
    expect(h.first().connection).toBe('closed')
    expect(h.first().observation?.historical).toBe(true)
    expect(h.peer(1).closed).toBe(1)
  })
})

test('signalling failures back off exponentially with jitter: six reopens, then stop', async () => {
  const h = setup(true, () => 0)
  await fakeTimers(h, async () => {
    await h.view.discover()
    const delays: (number | null)[] = []
    for (let attempt = 0; attempt < 8; attempt++) {
      h.peer(h.peers.length - 1).input.onHealth({
        kind: 'closed',
        reason: 'disconnected',
      })
      expect(h.first().connection).toBe('closed')
      delays.push(await nextPeer(h, 120_000))
      if (delays.at(-1) === null) break
    }
    // 2^n s capped at 30 s, jitter 0.5, rounded up to the 1 s view tick.
    expect(delays).toEqual([1000, 2000, 4000, 8000, 15_000, 15_000, null])
    expect(h.peers).toHaveLength(7)
  })
})

test('a flapping producer (admit, one frame, close) cannot reset the budget', async () => {
  const h = setup(true, () => 0)
  await fakeTimers(h, async () => {
    await h.view.discover()
    for (let attempt = 0; attempt < 10; attempt++) {
      const index = h.peers.length - 1
      send(h, index, admit(h, index), 0)
      expect(h.first().observation?.historical).toBe(false)
      h.peer(index).input.onHealth({ kind: 'closed', reason: 'disconnected' })
      if ((await nextPeer(h, 120_000)) === null) break
    }
    expect(h.peers).toHaveLength(7)
    expect(h.first().connection).toBe('closed')
  })
})

test('two Connectors back off independently', async () => {
  const agentB = '00000000-0000-4000-8000-000000000006'
  const h = setup(true, () => 0)
  h.data.printers.printers.push({
    ...row,
    assignmentId: '00000000-0000-4000-8000-000000000007',
    agentId: agentB,
    printerKey: 'b',
  })
  await fakeTimers(h, async () => {
    await h.view.discover()
    const peersOf = (agentId: string) =>
      h.peers.filter((peer) => peer.input.agentId === agentId)
    expect(peersOf(agent)).toHaveLength(1)
    expect(peersOf(agentB)).toHaveLength(1)
    const indexB = h.peers.indexOf(peersOf(agentB)[0]!)
    const sessionB = admit(h, indexB, agentB)
    // Agent A fails three times in a row while B keeps streaming.
    for (let attempt = 0; attempt < 3; attempt++) {
      const last = peersOf(agent).at(-1)!
      last.input.onHealth({ kind: 'closed', reason: 'disconnected' })
      while (peersOf(agent).at(-1) === last) {
        send(h, indexB, sessionB, h.time.mono, 'b')
        await second()
      }
    }
    expect(peersOf(agent)).toHaveLength(4)
    expect(peersOf(agentB)).toHaveLength(1)
    const rowB = () =>
      h.ready().rows.find((item) => item.assignment.agentId === agentB)
    expect(rowB()?.connection).toBe('authenticated')
    // B's first failure starts at its own budget: 2 s * 0.5.
    peersOf(agentB)[0]!.input.onHealth({
      kind: 'closed',
      reason: 'disconnected',
    })
    const from = h.time.mono
    while (peersOf(agentB).length === 1) await second()
    expect(h.time.mono - from).toBe(1000)
  })
})

test('rejected, revoked, or server-revoked Connectors stop and refresh; 401 on re-check signs out', async () => {
  for (const reason of ['rejected', 'revoked'] as const) {
    const h = setup(true, () => 0)
    await fakeTimers(h, async () => {
      await h.view.discover()
      h.peer().input.onHealth({ kind: 'closed', reason })
      expect(await nextPeer(h, 120_000)).toBeNull()
    })
  }
  const revoked = setup(true, () => 0)
  await fakeTimers(revoked, async () => {
    await revoked.view.discover()
    revoked.data.printers.printers = [{ ...row, connectorStatus: 'revoked' }]
    revoked.peer().input.onHealth({ kind: 'closed', reason: 'disconnected' })
    expect(await nextPeer(revoked, 120_000)).toBeNull()
    // The reopen re-check refreshes the farm, so the revocation is shown.
    expect(revoked.first().assignment.connectorStatus).toBe('revoked')
    expect(revoked.first().connection).toBe('unavailable')
    expect(revoked.ready().scope?.farmId).toBe(farm)
  })
  const signedOut = setup(true, () => 0)
  await fakeTimers(signedOut, async () => {
    await signedOut.view.discover()
    signedOut.hooks.read = async (path, signal, query) => {
      if (path === '/api/auth/me')
        throw Object.assign(new Error('401'), { statusCode: 401 })
      return signedOut.baseRead(path, signal, query)
    }
    signedOut.peer().input.onHealth({ kind: 'closed', reason: 'disconnected' })
    expect(await nextPeer(signedOut, 10_000)).toBeNull()
    expect(signedOut.result.state.kind).toBe('sign-in-required')
  })
})

test('non-finite injected jitter falls back to the midpoint', async () => {
  const h = setup(true, () => Number.NaN)
  await fakeTimers(h, async () => {
    await h.view.discover()
    h.peer().input.onHealth({ kind: 'closed', reason: 'disconnected' })
    // 2 s * 0.75 = 1.5 s, observed on the next 1 s tick.
    expect(await nextPeer(h)).toBe(2000)
  })
})

test('producer teardown failure still schedules a reopen', async () => {
  const h = setup(true, () => 0)
  await fakeTimers(h, async () => {
    let fail = true
    await h.view.discover()
    h.hooks.close = () => {
      if (fail) {
        fail = false
        throw new Error('teardown')
      }
    }
    h.peer(0).input.onHealth({ kind: 'closed', reason: 'disconnected' })
    expect(h.first().connection).toBe('closed')
    expect(await nextPeer(h)).toBe(1000)
    expect(h.first().connection).toBe('connecting')
  })
})

test('logout invalidation, route leave and unmount cancel pending reopens and leave no timers', async () => {
  vi.useFakeTimers()
  try {
    for (const action of ['invalidate', 'dispose'] as const) {
      const h = setup(true, () => 0)
      const stop = liveClock(h)
      await h.view.discover()
      h.peer().input.onHealth({ kind: 'closed', reason: 'disconnected' })
      expect(h.first().connection).toBe('closed')
      // Auth invalidation and route leave run invalidate(); unmount runs dispose().
      h.view[action]()
      await second(120_000)
      expect(h.peers).toHaveLength(1)
      expect(h.peer().input.signal.aborted).toBe(true)
      stop()
      h.view.dispose()
    }
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

test('an assignment set changed on the server refreshes the farm and resubscribes with it', async () => {
  const h = setup(true, () => 0)
  await fakeTimers(h, async () => {
    await h.view.discover()
    h.data.printers.printers = [
      row,
      { ...row, assignmentId: other, printerKey: 'second' },
    ]
    h.peer().input.onHealth({ kind: 'closed', reason: 'disconnected' })
    expect(await nextPeer(h)).not.toBeNull()
    expect(h.peer(0).input.signal.aborted).toBe(true)
    expect(h.ready().rows).toHaveLength(2)
    expect(
      h.peer(1).input.assignmentRefs.map((ref) => ref.assignmentId),
    ).toEqual([assignment, other])
  })
})

test('agents share one in-flight authority re-check per run', async () => {
  const agentB = '00000000-0000-4000-8000-000000000006'
  const h = setup(true, () => 0)
  h.data.printers.printers.push({
    ...row,
    assignmentId: '00000000-0000-4000-8000-000000000007',
    agentId: agentB,
    printerKey: 'b',
  })
  await fakeTimers(h, async () => {
    await h.view.discover()
    expect(h.peers).toHaveLength(2)
    const before = h.requests.length
    for (const peer of [...h.peers])
      peer.input.onHealth({ kind: 'closed', reason: 'disconnected' })
    while (h.peers.length < 4) await second()
    expect(h.requests.slice(before).map((request) => request.path)).toEqual([
      '/api/auth/me',
      `/api/farms/${farm}/printers`,
      '/api/auth/me',
    ])
    expect(new Set(h.peers.slice(2).map((peer) => peer.input.agentId))).toEqual(
      new Set([agent, agentB]),
    )
  })
})

test('429 on the re-check honours Retry-After and does not spend the reopen budget', async () => {
  const h = setup(true, () => 0)
  await fakeTimers(h, async () => {
    await h.view.discover()
    let limited = 0
    h.hooks.read = async (path, signal, query) => {
      if (path === `/api/farms/${farm}/printers` && limited < 10) {
        limited++
        throw Object.assign(new Error('429'), {
          statusCode: 429,
          response: new Response(null, {
            status: 429,
            headers: { 'retry-after': '5' },
          }),
        })
      }
      return h.baseRead(path, signal, query)
    }
    h.peer().input.onHealth({ kind: 'closed', reason: 'disconnected' })
    // First reopen at 1 s, then ten rate-limited re-checks 5 s apart, then success.
    const elapsed = await nextPeer(h, 120_000)
    expect(limited).toBe(10)
    expect(elapsed).toBe(1000 + 10 * 5000)
    expect(h.peers).toHaveLength(2)
  })
})
