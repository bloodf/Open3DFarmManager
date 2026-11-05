import { z } from 'zod'
import {
  BrowserDeviceHttpAccountResponse,
  BrowserDeviceHttpListResponse,
} from '../../../../packages/farm-protocol/src/browser-device-http.ts'
import { BrowserDeviceUuid } from '../../../../packages/farm-protocol/src/browser-device-proof.ts'
import { PrinterState } from '../../../../packages/farm-protocol/src/state.ts'
import { StatusMessage } from '../../../../packages/farm-protocol/src/channel.ts'

const exactKey = PrinterState.shape.printerKey.refine(
  (value) =>
    !value.includes('\0') &&
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      value,
    ),
)
export const FarmDiscoveryPage = z
  .strictObject({
    farms: z.array(z.strictObject({ farmId: BrowserDeviceUuid })).max(50),
    nextAfter: BrowserDeviceUuid.nullable(),
  })
  .refine(
    (page) =>
      new Set(page.farms.map((farm) => farm.farmId)).size === page.farms.length,
  )
export const FarmAssignmentPage = z
  .strictObject({
    printers: z
      .array(
        z.strictObject({
          assignmentId: BrowserDeviceUuid,
          agentId: BrowserDeviceUuid,
          printerKey: exactKey,
          status: z.enum(['active', 'revoked']),
          connectorStatus: z.enum(['pending', 'approved', 'revoked']),
        }),
      )
      .max(50),
    nextAfter: BrowserDeviceUuid.nullable(),
    canManage: z.boolean(),
  })
  .refine(
    (page) =>
      new Set(page.printers.map((row) => row.assignmentId)).size ===
      page.printers.length,
  )
const BoundedAssignmentPage = FarmAssignmentPage.refine(
  (page) => page.printers.length <= 20,
)
export type FarmAssignment = z.infer<
  typeof FarmAssignmentPage
>['printers'][number]
export type FarmScope = Readonly<{
  accountId: string
  farmId: string
  viewEpoch: number
}>
type Clock = { wall: number; mono: number }
const safeTime = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const monoTime = z.number().finite().nonnegative()
const AdmittedSession = z.strictObject({
  transportId: z.string().min(1).max(128),
  peerGeneration: safeTime,
  accountId: BrowserDeviceHttpAccountResponse.shape.accountId,
  farmId: BrowserDeviceUuid,
  agentId: BrowserDeviceUuid,
  browserKeyId: BrowserDeviceUuid,
  expiresAt: safeTime,
  deadlineMonoMs: monoTime,
})
export type FarmAdmittedSession = z.infer<typeof AdmittedSession>
export type FarmHealth =
  | { kind: 'connecting' | 'verifying' }
  | { kind: 'authenticated'; session: FarmAdmittedSession }
  | {
      kind: 'closed'
      reason: 'expired' | 'revoked' | 'disconnected' | 'rejected'
    }
export type FarmSnapshot = {
  session: FarmAdmittedSession
  message: z.infer<typeof StatusMessage>
  receivedAtWallMs: number
  receivedAtMonoMs: number
  sourceClockComparable: boolean
  complete: true
}
/** Producer must perform genuine current authorization and RTC admission before emitting.
 * One bounded complete snapshot per Connector, <=2048 UTF-8 bytes. No commands/media.
 * Session metadata is display evidence, never a substitute for producer authorization.
 */
export type FarmStatusFeed = {
  open(input: {
    scope: FarmScope
    agentId: string
    assignmentRefs: readonly Pick<
      FarmAssignment,
      'assignmentId' | 'agentId' | 'printerKey'
    >[]
    browserKeyId: string
    signal: AbortSignal
    onHealth: (health: FarmHealth) => void
    onSnapshot: (snapshot: FarmSnapshot) => void
  }): { close(): void }
}
export type FarmObservation = {
  state: z.infer<typeof PrinterState>
  received: Clock
  sourceClockComparable: boolean
  historical: boolean
}
export type FarmRow = {
  assignment: FarmAssignment
  connection:
    | 'unavailable'
    | 'connecting'
    | 'verifying'
    | 'authenticated'
    | 'closed'
  observation: FarmObservation | null
  localOrigin: string | null
}
export type FarmKeyState =
  | { kind: 'loading' }
  | {
      kind: 'unavailable'
      reason:
        | 'storage'
        | 'registry'
        | 'incomplete'
        | 'missing'
        | 'pending'
        | 'revoked'
    }
  | {
      kind: 'available'
      choices: readonly { keyId: string; thumbprint: string }[]
      selected: string
    }
type Ready = {
  kind: 'ready'
  accountId: string
  farms: z.infer<typeof FarmDiscoveryPage>['farms']
  nextFarm: string | null
  farmAfter: string | null
  scope: FarmScope | null
  inventory: 'loading' | 'ready'
  feedScope: 'disabled' | 'idle' | 'loading' | 'ready' | 'unavailable'
  rows: FarmRow[]
  nextPrinter: string | null
  printerAfter: string | null
  canManage: boolean
  keys: FarmKeyState
}
export type FarmViewState =
  | { kind: 'loading' }
  | { kind: 'sign-in-required' }
  | {
      kind: 'error'
      reason:
        | 'forbidden'
        | 'rate-limit'
        | 'invalid-response'
        | 'unavailable'
        | 'account-changed'
    }
  | Ready
type Read = (
  path: string,
  signal: AbortSignal,
  query?: Record<string, string | number>,
) => Promise<unknown>
type Dependencies = {
  read: Read
  listKeys: (scope: {
    accountId: string
    farmId: string
  }) => Promise<readonly { thumbprint: string }[]>
  clock: () => Clock
  changed: (state: FarmViewState) => void
  feed?: FarmStatusFeed
}
class AccountChanged extends Error {}
function httpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return
  if ('statusCode' in error && typeof error.statusCode === 'number')
    return error.statusCode
  if ('status' in error && typeof error.status === 'number') return error.status
}
function sameSession(a: FarmAdmittedSession, b: FarmAdmittedSession): boolean {
  return (
    a.transportId === b.transportId &&
    a.peerGeneration === b.peerGeneration &&
    a.accountId === b.accountId &&
    a.farmId === b.farmId &&
    a.agentId === b.agentId &&
    a.browserKeyId === b.browserKeyId &&
    a.expiresAt === b.expiresAt &&
    a.deadlineMonoMs === b.deadlineMonoMs
  )
}
export function localInterfaceOrigin(input: string): string | null {
  if (!/^https?:\/\//i.test(input) || /[\s\p{Cc}\\?#@]/u.test(input))
    return null
  // Inspect the raw path too: URL normalization must not hide /a/.. or encoded tricks.
  if (!/^https?:\/\/[^/]+\/?$/i.test(input)) return null
  try {
    const url = new URL(input)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      return null
    return url.origin
  } catch {
    return null
  }
}
export function observationAge(observation: FarmObservation, now: Clock) {
  const elapsed = now.mono - observation.received.mono
  const validElapsed = Number.isFinite(elapsed) && elapsed >= 0
  const comparable =
    observation.sourceClockComparable &&
    validElapsed &&
    Math.abs(now.wall - observation.received.wall - elapsed) <= 2000 &&
    observation.state.observedAt <= observation.received.wall
  return {
    seconds: validElapsed ? Math.floor(elapsed / 1000) : null,
    sourceConfirmed: comparable,
    stale:
      observation.historical ||
      !validElapsed ||
      elapsed >= 30_000 ||
      (comparable && now.wall - observation.state.observedAt >= 30_000),
  }
}
export const printerStateLabel: Record<
  z.infer<typeof PrinterState>['state'],
  string
> = {
  idle: 'Ociosa',
  printing: 'Imprimindo',
  paused: 'Pausada',
  error: 'Erro',
  offline: 'Indisponível segundo o Connector',
}

export function createFarmView(deps: Dependencies) {
  let state: FarmViewState = { kind: 'loading' }
  let epoch = 0
  let requestGeneration = 0
  let controller = new AbortController()
  let disposed = false
  let connections: { expire(now: Clock): void; close(): void }[] = []
  const publish = (next: FarmViewState) => {
    state = next
    deps.changed(next)
  }
  function retire() {
    // Capture this run and detach old resources before external teardown can reenter.
    const oldController = controller,
      oldConnections = connections
    const currentEpoch = ++epoch,
      generation = ++requestGeneration
    controller = new AbortController()
    connections = []
    const signal = controller.signal
    const run = {
      signal,
      epoch: currentEpoch,
      current: () =>
        !disposed &&
        !signal.aborted &&
        currentEpoch === epoch &&
        generation === requestGeneration,
    }
    oldController.abort()
    for (const connection of oldConnections) connection.close()
    return run
  }
  function begin() {
    return retire()
  }
  function failed(error: unknown) {
    const run = retire()
    if (!run.current()) return
    const status = httpStatus(error)
    if (status === 401) return publish({ kind: 'sign-in-required' })
    publish({
      kind: 'error',
      reason:
        status === 403
          ? 'forbidden'
          : status === 429
            ? 'rate-limit'
            : error instanceof AccountChanged
              ? 'account-changed'
              : error instanceof z.ZodError
                ? 'invalid-response'
                : 'unavailable',
    })
  }
  async function me(signal: AbortSignal, expected?: string) {
    const value = BrowserDeviceHttpAccountResponse.parse(
      await deps.read('/api/auth/me', signal),
    )
    if (expected !== undefined && value.accountId !== expected)
      throw new AccountChanged()
    return value.accountId
  }
  async function discover(after: string | null = null) {
    if (disposed) return
    const run = begin()
    if (!run.current()) return
    publish({ kind: 'loading' })
    try {
      const accountId = await me(run.signal)
      if (!run.current()) return
      const page = FarmDiscoveryPage.parse(
        await deps.read('/api/farms', run.signal, {
          limit: 20,
          ...(after ? { after: BrowserDeviceUuid.parse(after) } : {}),
        }),
      )
      if (!run.current()) return
      await me(run.signal, accountId)
      if (!run.current()) return
      publish({
        kind: 'ready',
        accountId,
        farms: page.farms,
        nextFarm: page.nextAfter,
        farmAfter: after,
        scope: null,
        inventory: 'ready',
        feedScope: deps.feed ? 'idle' : 'disabled',
        rows: [],
        nextPrinter: null,
        printerAfter: null,
        canManage: false,
        keys: { kind: 'loading' },
      })
      if (
        run.current() &&
        after === null &&
        page.farms.length === 1 &&
        page.nextAfter === null &&
        page.farms[0]
      )
        await selectFarm(page.farms[0].farmId)
    } catch (error) {
      if (run.current()) failed(error)
    }
  }
  async function selectFarm(farmId: string, after: string | null = null) {
    if (disposed || state.kind !== 'ready') return
    const previous = state
    const run = begin()
    if (!run.current()) return
    if (!farmId || !previous.farms.some((farm) => farm.farmId === farmId)) {
      publish({
        ...previous,
        scope: null,
        rows: [],
        inventory: 'ready',
        feedScope: deps.feed ? 'idle' : 'disabled',
        keys: { kind: 'loading' },
        nextPrinter: null,
        printerAfter: null,
        canManage: false,
      })
      return
    }
    const scope: FarmScope = {
      accountId: previous.accountId,
      farmId,
      viewEpoch: run.epoch,
    }
    publish({
      ...previous,
      scope,
      inventory: 'loading',
      feedScope: deps.feed ? 'idle' : 'disabled',
      rows: [],
      nextPrinter: null,
      printerAfter: after,
      canManage: false,
      keys: { kind: 'loading' },
    })
    try {
      await me(run.signal, scope.accountId)
      if (!run.current()) return
      const page = BoundedAssignmentPage.parse(
        await deps.read(`/api/farms/${farmId}/printers`, run.signal, {
          limit: 20,
          ...(after ? { after: BrowserDeviceUuid.parse(after) } : {}),
        }),
      )
      if (!run.current()) return
      await me(run.signal, scope.accountId)
      if (!run.current() || state.kind !== 'ready') return
      publish({
        ...state,
        inventory: 'ready',
        rows: page.printers.map((assignment) => ({
          assignment,
          connection: 'unavailable',
          observation: null,
          localOrigin: null,
        })),
        nextPrinter: page.nextAfter,
        canManage: page.canManage,
      })
      await loadKeys(scope, run)
    } catch (error) {
      if (run.current()) failed(error)
    }
  }
  async function loadKeys(scope: FarmScope, run: ReturnType<typeof begin>) {
    let local: readonly { thumbprint: string }[]
    try {
      local = await deps.listKeys(scope)
    } catch {
      if (run.current() && state.kind === 'ready')
        publish({ ...state, keys: { kind: 'unavailable', reason: 'storage' } })
      return
    }
    if (!run.current()) return
    try {
      const devices: z.infer<typeof BrowserDeviceHttpListResponse>['devices'] =
        []
      const seen = new Set<string>()
      let after: string | null = null
      let complete = false
      for (let pageNumber = 0; pageNumber < 32; pageNumber++) {
        const page = BrowserDeviceHttpListResponse.parse(
          await deps.read('/api/browser-devices', run.signal, {
            farm_id: scope.farmId,
            limit: 20,
            ...(after ? { after } : {}),
          }),
        )
        if (!run.current()) return
        if (page.currentAccountId !== scope.accountId)
          throw new AccountChanged()
        for (const device of page.devices) {
          if (seen.has(device.keyId))
            throw new Error('Invalid registry pagination')
          seen.add(device.keyId)
          devices.push(device)
        }
        if (page.nextAfter === null) {
          complete = true
          break
        }
        if (after === page.nextAfter) throw new Error('Invalid registry cursor')
        after = page.nextAfter
      }
      await me(run.signal, scope.accountId)
      if (!run.current() || state.kind !== 'ready') return
      if (!complete) {
        publish({
          ...state,
          keys: { kind: 'unavailable', reason: 'incomplete' },
        })
        return
      }
      const matched = devices.filter(
        (device) =>
          device.accountId === scope.accountId &&
          local.some((key) => key.thumbprint === device.thumbprint),
      )
      const choices = matched
        .filter(
          (device) => device.status === 'approved' && device.proofAt !== null,
        )
        .map(({ keyId, thumbprint }) => ({ keyId, thumbprint }))
      if (!choices.length) {
        publish({
          ...state,
          keys: {
            kind: 'unavailable',
            reason: matched.some((device) => device.status === 'pending')
              ? 'pending'
              : matched.some((device) => device.status === 'revoked')
                ? 'revoked'
                : 'missing',
          },
        })
        return
      }
      const selected =
        choices.length === 1 && choices[0] ? choices[0].keyId : ''
      publish({ ...state, keys: { kind: 'available', choices, selected } })
      if (selected) await prepareFeeds(scope, selected, run)
    } catch (error) {
      if (!run.current()) return
      if (
        httpStatus(error) === 401 ||
        httpStatus(error) === 403 ||
        error instanceof AccountChanged
      ) {
        failed(error)
        return
      }
      // Inventory stays visible, but no unconfirmed key may admit a feed.
      if (state.kind === 'ready')
        publish({ ...state, keys: { kind: 'unavailable', reason: 'registry' } })
    }
  }
  async function selectKey(keyId: string) {
    if (
      disposed ||
      state.kind !== 'ready' ||
      !state.scope ||
      state.keys.kind !== 'available'
    )
      return
    const previous = state,
      previousScope = state.scope,
      keys = state.keys
    if (keyId && !keys.choices.some((choice) => choice.keyId === keyId)) return
    const run = begin()
    if (!run.current()) return
    const scope = { ...previousScope, viewEpoch: run.epoch }
    publish({
      ...previous,
      scope,
      rows: previous.rows.map((row) => ({
        ...row,
        connection: 'unavailable',
        observation: null,
        localOrigin: null,
      })),
      keys: { ...keys, selected: keyId },
      feedScope: deps.feed ? 'idle' : 'disabled',
    })
    if (keyId) await prepareFeeds(scope, keyId, run)
  }
  async function prepareFeeds(
    scope: FarmScope,
    browserKeyId: string,
    run: ReturnType<typeof begin>,
  ) {
    if (!deps.feed || !run.current() || state.kind !== 'ready') return
    const visible = state.rows.map(({ assignment }) =>
      Object.freeze({ ...assignment }),
    )
    const agents = new Set(
      visible
        .filter(
          (row) =>
            row.status === 'active' && row.connectorStatus === 'approved',
        )
        .map((row) => row.agentId),
    )
    if (!agents.size) return
    publish({ ...state, feedScope: 'loading' })
    if (!run.current()) return
    try {
      await me(run.signal, scope.accountId)
      if (!run.current()) return
      const assignments = new Map<string, Readonly<FarmAssignment>>()
      const cursors = new Set<string>()
      const activeKeys = new Set<string>()
      const connectorStatuses = new Map<
        string,
        FarmAssignment['connectorStatus']
      >()
      let after: string | null = null,
        complete = false
      for (let pageNumber = 0; pageNumber < 32; pageNumber++) {
        const page = BoundedAssignmentPage.parse(
          await deps.read(`/api/farms/${scope.farmId}/printers`, run.signal, {
            limit: 20,
            ...(after ? { after } : {}),
          }),
        )
        if (!run.current()) return
        for (const row of page.printers) {
          if (assignments.has(row.assignmentId))
            throw Error('Duplicate inventory assignment')
          const status = connectorStatuses.get(row.agentId)
          if (status !== undefined && status !== row.connectorStatus)
            throw Error('Contradictory Connector status')
          connectorStatuses.set(row.agentId, row.connectorStatus)
          if (row.status === 'active') {
            const key = JSON.stringify([row.agentId, row.printerKey])
            if (activeKeys.has(key)) throw Error('Duplicate active printer key')
            activeKeys.add(key)
          }
          assignments.set(row.assignmentId, Object.freeze({ ...row }))
        }
        if (page.nextAfter === null) {
          complete = true
          break
        }
        if (!page.printers.length || cursors.has(page.nextAfter))
          throw Error('Inventory cursor cycle')
        cursors.add(page.nextAfter)
        after = page.nextAfter
      }
      await me(run.signal, scope.accountId)
      if (!run.current() || state.kind !== 'ready') return
      if (!complete) throw Error('Incomplete inventory scope')
      for (const row of visible) {
        const candidate = assignments.get(row.assignmentId)
        if (
          !candidate ||
          candidate.agentId !== row.agentId ||
          candidate.printerKey !== row.printerKey ||
          candidate.status !== row.status ||
          candidate.connectorStatus !== row.connectorStatus
        )
          throw Error('Visible assignment changed during scan')
      }
      const groups = new Map<
        string,
        readonly Pick<
          FarmAssignment,
          'assignmentId' | 'agentId' | 'printerKey'
        >[]
      >()
      for (const agentId of agents) {
        const refs = Object.freeze(
          [...assignments.values()]
            .filter(
              (row) =>
                row.agentId === agentId &&
                row.status === 'active' &&
                row.connectorStatus === 'approved',
            )
            .map(({ assignmentId, agentId, printerKey }) =>
              Object.freeze({ assignmentId, agentId, printerKey }),
            ),
        )
        // Reserve conservative numeric JSON width as well as escaped UTF8 keys.
        // This is a capacity check, not an invitation to truncate or split sets.
        const bytes =
          new TextEncoder().encode(
            JSON.stringify({
              t: 'snapshot',
              seq: Number.MAX_SAFE_INTEGER,
              printers: refs.map((ref) => ({
                printerKey: ref.printerKey,
                state: 'printing',
                progress: 0,
                observedAt: Number.MAX_SAFE_INTEGER,
              })),
            }),
          ).byteLength +
          refs.length * 24
        if (!refs.length || refs.length > 100 || bytes > 2048)
          throw Error('Complete Connector frame capacity')
        groups.set(agentId, refs)
      }
      publish({ ...state, feedScope: 'ready' })
      if (!run.current()) return
      openFeeds(scope, browserKeyId, run, groups)
    } catch (error) {
      if (!run.current()) return
      if (
        httpStatus(error) === 401 ||
        httpStatus(error) === 403 ||
        error instanceof AccountChanged
      ) {
        failed(error)
        return
      }
      // Scope failure is distinct from local-key/registry availability.
      if (state.kind === 'ready')
        publish({ ...state, feedScope: 'unavailable' })
    }
  }
  function openFeeds(
    scope: FarmScope,
    browserKeyId: string,
    run: ReturnType<typeof begin>,
    groups: ReadonlyMap<
      string,
      readonly Pick<FarmAssignment, 'assignmentId' | 'agentId' | 'printerKey'>[]
    >,
  ) {
    if (!deps.feed || state.kind !== 'ready') return
    const agents = new Set(
      state.rows
        .filter(
          (row) =>
            row.assignment.status === 'active' &&
            row.assignment.connectorStatus === 'approved',
        )
        .map((row) => row.assignment.agentId),
    )
    for (const agentId of agents) {
      if (!run.current() || state.kind !== 'ready') return
      const refs = groups.get(agentId)
      if (!refs) return
      let terminal = false,
        session: FarmAdmittedSession | null = null,
        seq = -1
      let handle: { close(): void } | undefined
      const started = deps.clock()
      const current = () =>
        run.current() &&
        !terminal &&
        state.kind === 'ready' &&
        state.scope?.viewEpoch === scope.viewEpoch
      const update = (change: (row: FarmRow) => FarmRow) => {
        if (
          !run.current() ||
          state.kind !== 'ready' ||
          state.scope?.viewEpoch !== scope.viewEpoch
        )
          return
        publish({
          ...state,
          rows: state.rows.map((row) =>
            refs.some(
              (ref) =>
                ref.assignmentId === row.assignment.assignmentId &&
                ref.agentId === row.assignment.agentId &&
                ref.printerKey === row.assignment.printerKey,
            )
              ? change(row)
              : row,
          ),
        })
      }
      function close() {
        if (terminal) return
        terminal = true
        // Producer teardown cannot prevent retiring private view state.
        try {
          handle?.close()
        } catch {
          // Already terminal locally.
        }
      }
      function end() {
        if (!current()) return
        close()
        update((row) => ({
          ...row,
          connection: 'closed',
          observation: row.observation
            ? { ...row.observation, historical: true }
            : null,
        }))
      }
      function expire(now: Clock) {
        if (!current()) return
        if (
          !Number.isFinite(now.mono) ||
          !Number.isSafeInteger(now.wall) ||
          now.mono < started.mono ||
          now.wall < started.wall ||
          now.mono - started.mono >= 30_000 ||
          (session &&
            (now.wall >= session.expiresAt ||
              now.mono >= session.deadlineMonoMs))
        )
          end()
      }
      connections.push({ close, expire })
      update((row) => ({ ...row, connection: 'connecting' }))
      try {
        handle = deps.feed.open({
          scope,
          agentId,
          assignmentRefs: refs,
          browserKeyId,
          signal: run.signal,
          onHealth(health) {
            expire(deps.clock())
            if (!current()) return
            if (health.kind === 'closed') {
              end()
              return
            }
            if (health.kind === 'authenticated') {
              const parsed = AdmittedSession.safeParse(health.session),
                now = deps.clock()
              if (!parsed.success) {
                end()
                return
              }
              const candidate = parsed.data
              if (
                candidate.accountId !== scope.accountId ||
                candidate.farmId !== scope.farmId ||
                candidate.agentId !== agentId ||
                candidate.browserKeyId !== browserKeyId ||
                candidate.expiresAt <= now.wall ||
                candidate.expiresAt - now.wall > 30_000 ||
                candidate.deadlineMonoMs <= now.mono ||
                candidate.deadlineMonoMs - now.mono > 30_000 ||
                (session && !sameSession(session, candidate))
              ) {
                end()
                return
              }
              session = candidate
              update((row) => ({ ...row, connection: 'authenticated' }))
            } else if (
              !session &&
              (health.kind === 'connecting' || health.kind === 'verifying')
            ) {
              update((row) => ({ ...row, connection: health.kind }))
            }
          },
          onSnapshot(snapshot) {
            const now = deps.clock()
            expire(now)
            if (!current() || !session) return
            const parsedSession = AdmittedSession.safeParse(snapshot.session)
            const parsed = StatusMessage.safeParse(snapshot.message)
            if (
              !parsedSession.success ||
              !sameSession(session, parsedSession.data) ||
              !parsed.success ||
              snapshot.complete !== true ||
              typeof snapshot.sourceClockComparable !== 'boolean'
            ) {
              end()
              return
            }
            const message = parsed.data
            if (
              new TextEncoder().encode(JSON.stringify(message)).byteLength >
                2048 ||
              !Number.isSafeInteger(message.seq) ||
              message.printers.some(
                (printer) =>
                  !Number.isSafeInteger(printer.observedAt) ||
                  !exactKey.safeParse(printer.printerKey).success,
              ) ||
              new Set(message.printers.map((printer) => printer.printerKey))
                .size !== message.printers.length ||
              !safeTime.safeParse(snapshot.receivedAtWallMs).success ||
              !monoTime.safeParse(snapshot.receivedAtMonoMs).success ||
              snapshot.receivedAtWallMs < started.wall ||
              snapshot.receivedAtWallMs > now.wall ||
              snapshot.receivedAtMonoMs < started.mono ||
              snapshot.receivedAtMonoMs > now.mono
            ) {
              end()
              return
            }
            if (
              message.printers.length !== refs.length ||
              refs.some(
                (ref) =>
                  !message.printers.some(
                    (printer) => printer.printerKey === ref.printerKey,
                  ),
              )
            ) {
              end()
              return
            }
            if (message.seq <= seq) return
            seq = message.seq
            update((row) => {
              const printer = message.printers.find(
                (item) => item.printerKey === row.assignment.printerKey,
              )
              if (!printer)
                return {
                  ...row,
                  observation: row.observation
                    ? { ...row.observation, historical: true }
                    : null,
                }
              const old = row.observation
              if (
                old &&
                (printer.observedAt < old.state.observedAt ||
                  (printer.observedAt === old.state.observedAt &&
                    (printer.state !== old.state.state ||
                      printer.progress !== old.state.progress)))
              )
                return {
                  ...row,
                  observation: {
                    ...old,
                    historical: true,
                    sourceClockComparable: false,
                  },
                }
              return {
                ...row,
                observation: {
                  state: printer,
                  received: {
                    wall: snapshot.receivedAtWallMs,
                    mono: snapshot.receivedAtMonoMs,
                  },
                  sourceClockComparable: snapshot.sourceClockComparable,
                  historical: false,
                },
              }
            })
          },
        })
        if (terminal) handle.close()
      } catch {
        end()
      }
    }
  }
  function confirmOrigin(
    assignmentId: string,
    input: string,
    confirmed: boolean,
  ) {
    const origin = localInterfaceOrigin(input)
    if (
      disposed ||
      state.kind !== 'ready' ||
      !state.scope ||
      state.inventory !== 'ready' ||
      !confirmed ||
      !origin
    )
      return false
    const row = state.rows.find(
      (row) => row.assignment.assignmentId === assignmentId,
    )
    if (
      !row ||
      row.assignment.status !== 'active' ||
      row.assignment.connectorStatus === 'revoked'
    )
      return false
    publish({
      ...state,
      rows: state.rows.map((row) =>
        row.assignment.assignmentId === assignmentId
          ? { ...row, localOrigin: origin }
          : row,
      ),
    })
    return true
  }
  return {
    discover,
    selectFarm,
    selectKey,
    confirmOrigin,
    tick: () => {
      for (const connection of connections) connection.expire(deps.clock())
    },
    invalidate: () => {
      const run = retire()
      if (run.current()) publish({ kind: 'loading' })
    },
    dispose: () => {
      disposed = true
      retire()
      publish({ kind: 'loading' })
    },
  }
}
