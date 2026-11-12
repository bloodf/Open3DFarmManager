import { afterEach, expect, test, vi } from 'vitest'
import type { FarmStatusFeed } from '../../apps/farm/app/utils/farm-view.ts'

declare global {
  // Nuxt auto-import used by the composable; stubbed per test.
  var $fetch: <T>(path: string, options?: object) => Promise<T>
}
type FeedInput = Parameters<FarmStatusFeed['open']>[0]
const peers: { input: FeedInput; closed: number }[] = []
const leave: (() => void)[] = []
const mounted: (() => void)[] = []
const unmounted: (() => void)[] = []
// vue and vue-router are app dependencies; mock them by their resolved Node
// entries. Only lifecycle registration matters here, not rendering.
vi.mock('../../apps/farm/node_modules/vue/index.mjs', () => ({
  shallowRef: <T>(value: T) => ({ value }),
  computed: <T>(get: () => T) => ({
    get value() {
      return get()
    },
  }),
  onMounted: (hook: () => void) => mounted.push(hook),
  onBeforeUnmount: (hook: () => void) => unmounted.push(hook),
}))
vi.mock('../../apps/farm/node_modules/vue-router/vue-router.node.mjs', () => ({
  onBeforeRouteLeave: (hook: () => void) => leave.push(hook),
}))
vi.mock('../../apps/farm/app/utils/webrtc/farm-status-feed.ts', () => ({
  createAuthenticatedFarmStatusFeed: (): FarmStatusFeed => ({
    open(input) {
      const peer = { input, closed: 0 }
      peers.push(peer)
      return { close: () => void peer.closed++ }
    },
  }),
}))
vi.mock('../../apps/farm/app/utils/webrtc/farm-status-key-resolver.ts', () => ({
  createFarmStatusKeyResolver: () => async () => {
    throw new Error('Not used by the injected feed')
  },
}))
vi.mock('../../apps/farm/app/utils/device-key.ts', () => ({
  listDeviceKeys: async () => [{ thumbprint: 'A'.repeat(43) }],
}))
const { useFarmView } =
  await import('../../apps/farm/app/composables/useFarmView.ts')

const farm = '00000000-0000-4000-8000-000000000001'
const agent = '00000000-0000-4000-8000-000000000002'
const keyId = '00000000-0000-4000-8000-000000000004'
async function read(path: string) {
  if (path === '/api/auth/me') return { accountId: 'account-one' }
  if (path === '/api/farms')
    return { farms: [{ farmId: farm }], nextAfter: null }
  if (path === `/api/farms/${farm}/printers`)
    return {
      printers: [
        {
          assignmentId: '00000000-0000-4000-8000-000000000003',
          agentId: agent,
          printerKey: 'printer',
          status: 'active',
          connectorStatus: 'approved',
        },
      ],
      nextAfter: null,
      canManage: true,
    }
  if (path === '/api/browser-devices')
    return {
      currentAccountId: 'account-one',
      currentRole: 'owner',
      devices: [
        {
          keyId,
          accountId: 'account-one',
          thumbprint: 'A'.repeat(43),
          status: 'approved',
          proofAt: 10,
          createdAt: 0,
          pendingExpiresAt: null,
        },
      ],
      nextAfter: null,
      limits: {
        pendingLifetimeMs: 86_400_000,
        proofLifetimeMs: 60_000,
        maxChallengesPerKey: 3,
      },
    }
  throw new Error(`Unexpected request: ${path}`)
}
async function settle() {
  for (let index = 0; index < 20; index++) await vi.advanceTimersByTimeAsync(0)
}
async function nextPeer(limit = 120_000) {
  const count = peers.length
  for (let at = 0; at < limit && peers.length === count; at += 1000)
    await vi.advanceTimersByTimeAsync(1000)
  return peers.length > count
}
function closeLast() {
  peers.at(-1)!.input.onHealth({ kind: 'closed', reason: 'disconnected' })
}

afterEach(() => {
  peers.length = 0
  leave.length = 0
  mounted.length = 0
  unmounted.length = 0
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

test('composable: exhausted reopen budget recovers on focus, pageshow and visibilitychange; route leave and unmount cancel', async () => {
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'Date',
      'performance',
    ],
  })
  const document = Object.assign(new EventTarget(), {
    visibilityState: 'visible',
  })
  vi.stubGlobal('window', new EventTarget())
  vi.stubGlobal('document', document)
  vi.stubGlobal('BroadcastChannel', undefined)
  vi.stubGlobal('$fetch', read)
  useFarmView()
  for (const hook of mounted) hook()
  await settle()
  expect(peers).toHaveLength(1)
  // Seven subscriptions (six reopens), then the budget is exhausted.
  for (let attempt = 0; attempt < 6; attempt++) {
    closeLast()
    expect(await nextPeer()).toBe(true)
  }
  closeLast()
  expect(await nextPeer()).toBe(false)
  expect(peers).toHaveLength(7)
  for (const [target, event] of [
    [globalThis.window, 'focus'],
    [globalThis.window, 'pageshow'],
    [document, 'visibilitychange'],
  ] as const) {
    const count = peers.length
    target.dispatchEvent(new Event(event))
    await settle()
    expect(peers).toHaveLength(count + 1)
    expect(peers[count - 1]!.input.signal.aborted).toBe(true)
  }
  // Route leave retires the run: a pending reopen never fires.
  closeLast()
  expect(leave).toHaveLength(1)
  leave[0]!()
  expect(await nextPeer()).toBe(false)
  // Unmount leaves no interval, retry or listener behind.
  globalThis.window.dispatchEvent(new Event('focus'))
  await settle()
  const count = peers.length
  for (const hook of unmounted) hook()
  expect(peers.at(-1)!.input.signal.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
  globalThis.window.dispatchEvent(new Event('focus'))
  document.dispatchEvent(new Event('visibilitychange'))
  await settle()
  expect(peers).toHaveLength(count)
})
