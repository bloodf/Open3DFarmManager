import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { canonicalize } from '../../../farm-protocol/src/canonical.ts'
import { configurationOpaqueId } from '../../../farm-protocol/src/configuration-common.ts'
import {
  ConfigurationRequestFrame,
  type ConfigurationErrorCode,
  type ConfigurationResponseFrame,
} from '../../../farm-protocol/src/configuration-frames.ts'
import {
  configurationReceiptHash,
  type SignedConfigurationReceipt,
} from '../../../farm-protocol/src/configuration-receipt.ts'
import { configurationTargetHash } from '../../../farm-protocol/src/configuration-target.ts'
import {
  createKobraLinkClient,
  KobraLinkError,
  type KobraLinkFetch,
  type PrinterIdentity,
} from '../kobralink/client.ts'
import {
  ProvisioningContext,
  isTrustedProvisioningAuthority,
  type InventoryAcknowledgement,
  type TrustedProvisioningAuthority,
} from './authority.ts'
import { createBridgeCustody, type BridgeRecord } from './bridge-custody.ts'
import {
  appendBounded,
  createJournal,
  MAX_OPERATIONS,
  TRANSITIONAL_STAGES,
  type JournalState,
  type ObservedPrinter,
  type OperationRecord,
  type OperationStage,
} from './journal.ts'
import { createPrinterNetworkPolicy, KOBRA_X_PRINTER_PORT } from './policy.ts'
import { acquirePrivateLock, ensurePrivateDirectory } from './private-fs.ts'
import {
  errorFrame,
  resultFrame,
  signOperationReceipt,
  unknownFrame,
  type ReceiptSigner,
} from './receipts.ts'
import {
  bindingFor,
  commitRuntimeAssignment,
  discardPlannedCredential,
  existingKobraBindings,
  runtimeContains,
  type RuntimeScope,
} from './runtime-commit.ts'

export interface ProvisioningEngineOptions {
  /** Absolute private directory for journal, locks and bridge custody. */
  stateDirectory: string
  /** Trusted enrollment scope and the accepted runtime configuration file. */
  runtime: RuntimeScope
  connector: ReceiptSigner
  authority: TrustedProvisioningAuthority
  /** Explicit local opt-in: the management service this Connector owns. */
  managedBridge: {
    origin: string
    ownership: 'connector-owned-fresh'
  } | null
  /** Operator-configured RFC 1918 CIDRs where printers may live. */
  printerNetworks: readonly string[]
  fetch?: KobraLinkFetch
  timeoutMs?: number
  clock?: () => number
  /** Observability hook after each durable stage write. Never an authority. */
  onDurableStage?: (stage: OperationStage, operationId: string) => void
}

export interface ProvisioningRequest {
  frame: unknown
  context: unknown
}

class Abort {
  readonly response: ConfigurationResponseFrame
  constructor(response: ConfigurationResponseFrame) {
    this.response = response
  }
}

const TERMINAL_PRUNABLE: readonly OperationStage[] = [
  'cancelled',
  'failed',
  'inventory-confirmed',
]
const PRINTER_NAME = 'Kobra X'
export type InventoryConfirmation =
  | { ok: true; receipt: SignedConfigurationReceipt }
  | { ok: false; reason: 'unknown' | 'mismatch' | 'rejected' | 'busy' }

/**
 * Durable Connector-local provisioning engine for config-v1
 * prepare/commit/status/cancel. Every call requires a current context from the
 * trusted authority adapter; neither a journal entry nor a signed receipt is
 * permission. Only printers this engine proved it created can be removed.
 */
export function createProvisioningEngine(options: ProvisioningEngineOptions) {
  if (!isTrustedProvisioningAuthority(options.authority))
    throw new Error('Provisioning requires an explicitly trusted authority')
  const policy = createPrinterNetworkPolicy(options.printerNetworks)
  if (options.managedBridge) {
    if (options.managedBridge.ownership !== 'connector-owned-fresh')
      throw new Error('Managed bridge ownership must be explicit')
    createKobraLinkClient({
      origin: options.managedBridge.origin,
      allowedOrigins: [options.managedBridge.origin],
    })
  }
  ensurePrivateDirectory(options.stateDirectory)
  const journal = createJournal(options.stateDirectory)
  const custody = createBridgeCustody(options.stateDirectory)
  const lockPath = join(options.stateDirectory, 'provisioning.lock')
  const clock = options.clock ?? Date.now
  const authority = options.authority
  let queue: Promise<unknown> = Promise.resolve()

  const clientFor = (bridge: Pick<BridgeRecord, 'origin'>) =>
    createKobraLinkClient({
      origin: bridge.origin,
      allowedOrigins: [bridge.origin],
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    })

  function serialized<T>(run: () => Promise<T>): Promise<T> {
    const next = queue.then(run, run)
    queue = next.catch(() => undefined)
    return next
  }

  function save(
    op: OperationRecord,
    stage: OperationStage,
    changes: Partial<OperationRecord> = {},
  ) {
    const record: OperationRecord = {
      ...op,
      ...changes,
      stage,
      updated_at: clock(),
    }
    journal.writeOperation(record)
    options.onDurableStage?.(stage, op.operation_id)
    return record
  }
  function setState(changes: Partial<JournalState>): JournalState {
    const next = { ...journal.readState(), ...changes }
    journal.writeState(next)
    return next
  }
  function finish(op: OperationRecord): void {
    const state = journal.readState()
    if (state.active === op.operation_id) setState({ active: null })
  }

  /** Operation view for a response. Never invents success. */
  function describe(
    frame: ConfigurationRequestFrame,
    op: OperationRecord,
  ): ConfigurationResponseFrame {
    switch (op.stage) {
      case 'prepared':
      case 'local-committed':
      case 'inventory-confirmed':
        return op.latest
          ? resultFrame(frame, op.latest)
          : errorFrame(frame.request_id, 'not-available')
      case 'recovery-required':
        if (op.latest?.phase === 'recovery-required')
          return resultFrame(frame, op.latest)
        return unknownFrame(
          frame,
          op.recovery === 'create-outcome-unknown'
            ? 'timeout-after-write'
            : 'connector-restarted',
        )
      case 'cancelled':
        return unknownFrame(frame, 'cancel-acknowledged')
      case 'failed':
        return errorFrame(frame.request_id, op.failure ?? 'not-available')
      default:
        return unknownFrame(frame, 'connector-restarted')
    }
  }

  async function toRecovery(
    op: OperationRecord,
    cause:
      'create-outcome-unknown' | 'rollback-failed' | 'journal-inconsistent',
  ): Promise<OperationRecord> {
    const draft: OperationRecord = { ...op, recovery: cause }
    const latest =
      op.latest && op.printer
        ? await signOperationReceipt(
            options.connector,
            draft,
            'recovery-required',
            clock(),
          )
        : op.latest
    return save(op, 'recovery-required', { recovery: cause, latest })
  }

  /**
   * Called with the lock held. A transitional stage means the previous holder
   * stopped mid-step: reconcile from local evidence, never assume success.
   */
  async function reconcile(op: OperationRecord): Promise<OperationRecord> {
    if (!TRANSITIONAL_STAGES.includes(op.stage)) return op
    switch (op.stage) {
      case 'accepted':
      case 'discovering': {
        const failed = save(op, 'failed', { failure: 'not-available' })
        finish(failed)
        return failed
      }
      case 'create-pending':
        return toRecovery(op, 'create-outcome-unknown')
      case 'compensating':
        return toRecovery(op, 'rollback-failed')
      case 'committing': {
        const bridge = op.bridge_instance_id
          ? custody.find(op.bridge_instance_id)
          : null
        if (!op.plan || !op.printer || !bridge)
          return toRecovery(op, 'journal-inconsistent')
        if (
          runtimeContains(
            options.runtime,
            bindingFor(op.plan, bridge, op.printer),
            op.plan,
          )
        )
          return finalizeCommit(op)
        discardPlannedCredential(op.plan)
        return save(op, 'prepared', { plan: null })
      }
      default:
        return op
    }
  }

  async function finalizeCommit(op: OperationRecord): Promise<OperationRecord> {
    const plan = op.plan
    if (!plan) throw new Error('Commit plan missing')
    const latest = await signOperationReceipt(
      options.connector,
      op,
      'local-committed',
      clock(),
    )
    const committed = save(op, 'local-committed', { latest })
    const state = journal.readState()
    setState({
      revision: Math.max(state.revision, plan.committed_revision),
      active: state.active === op.operation_id ? null : state.active,
    })
    return committed
  }

  async function stillCurrent(context: ProvisioningContext): Promise<boolean> {
    try {
      return (await authority.isCurrent(context)) === true
    } catch {
      return false
    }
  }

  function sameBinding(op: OperationRecord, context: ProvisioningContext) {
    return (
      op.binding.account_id === context.account_id &&
      op.binding.farm_id === context.farm_id &&
      op.binding.agent_id === context.agent_id &&
      op.binding.key_id === context.key_id
    )
  }

  function pruneFor(state: JournalState): JournalState {
    if (state.operations.length < MAX_OPERATIONS) return state
    const victim = state.operations.find((id) => {
      const record = journal.readOperation(id)
      return !record || TERMINAL_PRUNABLE.includes(record.stage)
    })
    if (!victim) throw new Abort(errorFrame(null, 'busy'))
    journal.removeOperation(victim)
    return setState({
      operations: state.operations.filter((id) => id !== victim),
    })
  }

  async function resolveBridge(
    op: OperationRecord,
  ): Promise<BridgeRecord | ConfigurationErrorCode> {
    const selection = op.target.bridge
    if (selection.kind === 'existing') {
      const bridge = custody.find(selection.bridge_instance_id)
      if (!bridge || bridge.state !== 'established') return 'not-available'
      const result = await custody.authenticateEstablished(
        clientFor(bridge),
        bridge,
      )
      return result.ok ? result.bridge : 'bridge-unavailable'
    }
    const managed = options.managedBridge
    if (!managed) return 'not-available'
    const result = await custody.bootstrapManaged(
      clientFor(managed),
      managed.origin,
    )
    return result.ok ? result.bridge : 'bridge-unavailable'
  }

  function observed(
    identity: PrinterIdentity,
    ownership: ObservedPrinter['ownership'],
  ): ObservedPrinter | null {
    if (!configurationOpaqueId.safeParse(identity.deviceId).success) return null
    if (!identity.ip) return null
    return {
      id: identity.id,
      device_id: identity.deviceId,
      ip: identity.ip,
      model: identity.model,
      firmware: identity.firmware,
      ownership,
    }
  }

  async function fail(
    op: OperationRecord,
    code: ConfigurationErrorCode,
  ): Promise<OperationRecord> {
    const failed = save(op, 'failed', { failure: code })
    finish(failed)
    return failed
  }

  /** Removes only a row this operation proved it created. */
  async function compensate(
    op: OperationRecord,
    context: ProvisioningContext,
    after: (op: OperationRecord) => Promise<OperationRecord>,
  ): Promise<OperationRecord> {
    const bridge = op.bridge_instance_id
      ? custody.find(op.bridge_instance_id)
      : null
    if (!op.printer || op.printer.ownership !== 'created' || !bridge)
      return after(op)
    if (!(await stillCurrent(context))) {
      // Never mutate without current authority. A prepared operation stays
      // cancellable; an unprepared owned row needs explicit recovery.
      if (op.stage !== 'prepared') await toRecovery(op, 'rollback-failed')
      throw new Abort(errorFrame(null, 'capability-rejected'))
    }
    const pending = save(op, 'compensating')
    try {
      const client = clientFor(bridge)
      const auth = await custody.authenticateEstablished(client, bridge)
      if (!auth.ok) throw new Error('bridge')
      await client.deleteOwnedPrinter({
        id: op.printer.id,
        deviceId: op.printer.device_id,
      })
    } catch {
      return toRecovery(pending, 'rollback-failed')
    }
    return after(pending)
  }

  async function discover(
    op: OperationRecord,
    bridge: BridgeRecord,
    context: ProvisioningContext,
  ): Promise<OperationRecord> {
    const client = clientFor(bridge)
    const auth = await custody.authenticateEstablished(client, bridge)
    if (!auth.ok) return fail(op, 'bridge-unavailable')
    let current = save(op, 'discovering', {
      bridge_instance_id: bridge.bridge_instance_id,
    })
    let identities: PrinterIdentity[]
    try {
      identities = await client.listPrinterIdentities()
    } catch (error) {
      return fail(
        current,
        error instanceof KobraLinkError && error.code === 'identity_changed'
          ? 'identity-conflict'
          : 'bridge-unavailable',
      )
    }
    const ip = op.target.endpoint.ipv4
    const expected = op.target.device_id
    const atIp = identities.filter((p) => p.ip === ip)
    const byDevice = expected
      ? identities.filter((p) => p.deviceId === expected)
      : []
    const bound = existingKobraBindings(options.runtime).bindings
    const isBound = (p: { id: string; deviceId: string }) =>
      bound.some(
        (b) =>
          b.bridgeInstance === bridge.bridge_instance_id &&
          (b.deviceId === p.deviceId || b.id === p.id),
      )
    let match: PrinterIdentity | undefined
    if (expected) {
      if (byDevice.length > 1 || atIp.some((p) => p.deviceId !== expected))
        return fail(current, 'identity-conflict')
      match = byDevice[0]
      if (match && match.ip !== ip) return fail(current, 'identity-conflict')
    } else {
      if (atIp.length > 1) return fail(current, 'identity-conflict')
      match = atIp[0]
    }
    if (match) {
      const printer = observed(match, 'preexisting')
      if (!printer || isBound(match)) return fail(current, 'identity-conflict')
      return save(current, current.stage, { printer })
    }
    if (!(await stillCurrent(context)))
      return fail(current, 'capability-rejected')
    // Durable before the write: a lost response is reconciled, never resent.
    current = save(current, 'create-pending', {
      before_ids: identities.map((p) => p.id),
    })
    let created: PrinterIdentity
    try {
      created = await client.createPrinter({ ip, name: PRINTER_NAME })
    } catch (error) {
      if (error instanceof KobraLinkError && error.code === 'unauthorized')
        return fail(current, 'bridge-unavailable')
      return toRecovery(current, 'create-outcome-unknown')
    }
    // A row listed before our write is not ours, whatever the response says.
    if ((current.before_ids ?? []).includes(created.id))
      return fail(current, 'identity-conflict')
    if (!configurationOpaqueId.safeParse(created.deviceId).success)
      // Unbindable identity: we cannot pin it for compensation either.
      return toRecovery(current, 'create-outcome-unknown')
    const withPrinter = save(current, 'create-pending', {
      printer: {
        id: created.id,
        device_id: created.deviceId,
        ip,
        model: created.model,
        firmware: created.firmware,
        ownership: 'created',
      },
    })
    if (
      created.ip !== ip ||
      (expected !== undefined && created.deviceId !== expected) ||
      isBound(created)
    )
      return compensate(withPrinter, context, (o) =>
        fail(o, 'identity-conflict'),
      )
    return withPrinter
  }

  async function prepare(
    frame: Extract<ConfigurationRequestFrame, { type: 'prepare' }>,
    context: ProvisioningContext,
    state: JournalState,
  ): Promise<ConfigurationResponseFrame> {
    const targetHash = await configurationTargetHash(frame.target)
    const existing = journal.readOperation(frame.operation_id)
    if (existing) {
      if (!sameBinding(existing, context))
        return errorFrame(frame.request_id, 'capability-rejected')
      if (existing.target_sha256 !== targetHash)
        return errorFrame(frame.request_id, 'identity-conflict')
      if (existing.expected_revision !== frame.expected_revision)
        return errorFrame(frame.request_id, 'revision-conflict')
      return describe(frame, await reconcile(existing))
    }
    if (state.active) return errorFrame(frame.request_id, 'busy')
    if (frame.expected_revision !== state.revision)
      return errorFrame(frame.request_id, 'revision-conflict')
    if (
      frame.target.endpoint.port !== KOBRA_X_PRINTER_PORT ||
      !policy.allows(frame.target.endpoint.ipv4)
    )
      return errorFrame(frame.request_id, 'invalid-request')
    if (
      frame.target.bridge.kind === 'connector-managed' &&
      !options.managedBridge
    )
      return errorFrame(frame.request_id, 'not-available')
    const pruned = pruneFor(state)
    const now = clock()
    let op: OperationRecord = {
      v: 1,
      operation_id: frame.operation_id,
      binding: {
        account_id: context.account_id,
        farm_id: context.farm_id,
        agent_id: context.agent_id,
        key_id: context.key_id,
        credential_jti: context.credential_jti,
        transport_id: context.transport_id,
      },
      target: frame.target,
      target_sha256: targetHash,
      expected_revision: frame.expected_revision,
      bridge_instance_id: null,
      stage: 'accepted',
      before_ids: null,
      printer: null,
      failure: null,
      recovery: null,
      plan: null,
      prepared: null,
      latest: null,
      created_at: now,
      updated_at: now,
    }
    op = save(op, 'accepted')
    setState({
      active: op.operation_id,
      operations: [...pruned.operations, op.operation_id],
    })
    const bridge = await resolveBridge(op)
    if (typeof bridge === 'string')
      return describe(frame, await fail(op, bridge))
    op = await discover(op, bridge, context)
    if (op.stage === 'failed' || op.stage === 'recovery-required')
      return describe(frame, op)
    const prepared = await signOperationReceipt(
      options.connector,
      op,
      'prepared',
      clock(),
    )
    op = save(op, 'prepared', { prepared, latest: prepared })
    return describe(frame, op)
  }

  async function commit(
    frame: Extract<ConfigurationRequestFrame, { type: 'commit' }>,
    context: ProvisioningContext,
    op: OperationRecord,
  ): Promise<ConfigurationResponseFrame> {
    const preparedHash = op.prepared
      ? await configurationReceiptHash(op.prepared)
      : null
    if (
      op.target_sha256 !== frame.target_sha256 ||
      preparedHash !== frame.prepared_receipt_sha256
    )
      return errorFrame(frame.request_id, 'identity-conflict')
    if (op.expected_revision !== frame.expected_revision)
      return errorFrame(frame.request_id, 'revision-conflict')
    if (op.stage !== 'prepared') return describe(frame, op)
    if (journal.readState().revision !== op.expected_revision)
      return errorFrame(frame.request_id, 'revision-conflict')
    const bridge = op.bridge_instance_id
      ? custody.find(op.bridge_instance_id)
      : null
    if (!bridge || bridge.state !== 'established' || !op.printer)
      return errorFrame(frame.request_id, 'bridge-unavailable')
    const current = existingKobraBindings(options.runtime)
    if (
      current.bindings.some(
        (b) =>
          b.bridgeInstance === bridge.bridge_instance_id &&
          (b.deviceId === op.printer?.device_id || b.id === op.printer?.id),
      )
    )
      return errorFrame(frame.request_id, 'identity-conflict')
    if (!(await stillCurrent(context)))
      return errorFrame(frame.request_id, 'capability-rejected')
    const base = `kobra-x-${op.printer.id}`.slice(0, 120)
    let key = base
    for (let n = 2; current.printerKeys.has(key); n++) key = `${base}-${n}`
    const assignmentId = randomUUID()
    const plan = {
      assignment_id: assignmentId,
      printer_key: key,
      credential_file: join(
        options.stateDirectory,
        'credentials',
        `${assignmentId}.json`,
      ),
      committed_revision: op.expected_revision + 1,
    }
    ensurePrivateDirectory(join(options.stateDirectory, 'credentials'))
    const committing = save(op, 'committing', { plan })
    try {
      commitRuntimeAssignment(options.runtime, plan, bridge, op.printer)
    } catch {
      if (
        !runtimeContains(
          options.runtime,
          bindingFor(plan, bridge, op.printer),
          plan,
        )
      ) {
        discardPlannedCredential(plan)
        save(committing, 'prepared', { plan: null })
        return errorFrame(frame.request_id, 'not-available')
      }
    }
    return describe(frame, await finalizeCommit(committing))
  }

  async function cancel(
    frame: Extract<ConfigurationRequestFrame, { type: 'cancel' }>,
    context: ProvisioningContext,
    op: OperationRecord,
  ): Promise<ConfigurationResponseFrame> {
    if (op.target_sha256 !== frame.target_sha256)
      return errorFrame(frame.request_id, 'identity-conflict')
    switch (op.stage) {
      case 'local-committed':
      case 'inventory-confirmed':
        return errorFrame(frame.request_id, 'invalid-request')
      case 'cancelled':
        return describe(frame, op)
      case 'prepared': {
        const done = await compensate(op, context, async (o) => {
          const cancelled = save(o, 'cancelled')
          finish(cancelled)
          return cancelled
        })
        return describe(frame, done)
      }
      default: {
        // recovery-required / failed: acknowledge, never delete ambiguous rows.
        const cancelled = save(op, 'cancelled')
        finish(cancelled)
        return describe(frame, cancelled)
      }
    }
  }

  /** Completes a state update interrupted after a durable commit record. */
  function normalizedState(): JournalState {
    const state = journal.readState()
    const active = state.active ? journal.readOperation(state.active) : null
    if (
      active?.plan &&
      (active.stage === 'local-committed' ||
        active.stage === 'inventory-confirmed')
    )
      return setState({
        active: null,
        revision: Math.max(state.revision, active.plan.committed_revision),
      })
    return state
  }

  async function dispatch(
    frame: ConfigurationRequestFrame,
    context: ProvisioningContext,
  ): Promise<ConfigurationResponseFrame> {
    const state = normalizedState()
    const digest = createHash('sha256')
      .update(canonicalize(frame))
      .digest('base64url')
    const requestEntry = state.requests.find((entry) =>
      entry.startsWith(frame.request_id + ':'),
    )
    if (requestEntry && requestEntry !== `${frame.request_id}:${digest}`)
      return errorFrame(frame.request_id, 'invalid-request')
    const replay = `${context.capability_id}:${context.admission_nonce}`
    if (state.consumed.includes(replay))
      return errorFrame(frame.request_id, 'capability-rejected')
    if (!(await stillCurrent(context)))
      return errorFrame(frame.request_id, 'capability-rejected')
    // Consume the capability durably before any action.
    const ledger = setState({
      consumed: appendBounded(state.consumed, replay),
      requests: appendBounded(state.requests, `${frame.request_id}:${digest}`),
    })
    if (frame.type === 'prepare') return prepare(frame, context, ledger)
    const found = journal.readOperation(frame.operation_id)
    if (!found) return unknownFrame(frame, 'no-durable-record')
    if (!sameBinding(found, context))
      return errorFrame(frame.request_id, 'capability-rejected')
    const op = await reconcile(found)
    if (frame.type === 'status') {
      if (op.target_sha256 !== frame.target_sha256)
        return errorFrame(frame.request_id, 'identity-conflict')
      return describe(frame, op)
    }
    if (frame.type === 'commit') return commit(frame, context, op)
    return cancel(frame, context, op)
  }

  async function locked<T>(busy: T, run: () => Promise<T>): Promise<T> {
    return serialized(async () => {
      const release = acquirePrivateLock(lockPath)
      if (!release) return busy
      try {
        return await run()
      } finally {
        release()
      }
    })
  }

  return Object.freeze({
    /** Integration entry for an authenticated config-v1 session request. */
    async handle(
      request: ProvisioningRequest,
    ): Promise<ConfigurationResponseFrame> {
      const frame = ConfigurationRequestFrame.safeParse(request?.frame)
      if (!frame.success) return errorFrame(null, 'invalid-request')
      const requestId = frame.data.request_id
      const context = ProvisioningContext.safeParse(request?.context)
      if (
        !context.success ||
        context.data.action !== frame.data.type ||
        context.data.farm_id !== options.runtime.farm_id ||
        context.data.agent_id !== options.runtime.agent_id ||
        context.data.connector_fingerprint !== options.connector.fingerprint
      )
        return errorFrame(requestId, 'capability-rejected')
      return locked(errorFrame(requestId, 'busy'), async () => {
        try {
          return await dispatch(frame.data, context.data)
        } catch (error) {
          if (error instanceof Abort)
            return error.response.type === 'error'
              ? errorFrame(requestId, error.response.code)
              : error.response
          // Opaque by design: no upstream, filesystem or secret detail escapes.
          return errorFrame(requestId, 'not-available')
        }
      })
    },
    /** Signed local-committed receipts awaiting server inventory confirmation. No credentials. */
    async pendingInventoryConfirmations(): Promise<
      { operation_id: string; receipt: SignedConfigurationReceipt }[]
    > {
      return locked([], async () =>
        journal
          .readState()
          .operations.map((id) => journal.readOperation(id))
          .filter(
            (op): op is OperationRecord =>
              op?.stage === 'local-committed' && op.latest !== null,
          )
          .map((op) => ({
            operation_id: op.operation_id,
            receipt: op.latest as SignedConfigurationReceipt,
          })),
      )
    },
    /**
     * Records an inventory acknowledgement accepted by the trusted adapter.
     * Idempotent: a repeated acknowledgement returns the same receipt.
     */
    async confirmInventory(
      ack: InventoryAcknowledgement,
    ): Promise<InventoryConfirmation> {
      return locked<InventoryConfirmation>(
        { ok: false, reason: 'busy' },
        async () => {
          try {
            const op = journal.readOperation(ack.operation_id)
            if (!op || !op.plan || !op.latest)
              return { ok: false, reason: 'unknown' }
            if (op.stage === 'inventory-confirmed') {
              return op.latest.prior_receipt_sha256 ===
                ack.local_committed_receipt_sha256
                ? { ok: true, receipt: op.latest }
                : { ok: false, reason: 'mismatch' }
            }
            if (op.stage !== 'local-committed')
              return { ok: false, reason: 'unknown' }
            if (
              (await configurationReceiptHash(op.latest)) !==
                ack.local_committed_receipt_sha256 ||
              ack.committed_revision !== op.plan.committed_revision
            )
              return { ok: false, reason: 'mismatch' }
            let accepted = false
            try {
              accepted =
                (await authority.acceptsInventoryAck({ ...ack })) === true
            } catch {
              accepted = false
            }
            if (!accepted) return { ok: false, reason: 'rejected' }
            const latest = await signOperationReceipt(
              options.connector,
              op,
              'inventory-confirmed',
              clock(),
            )
            save(op, 'inventory-confirmed', { latest })
            return { ok: true, receipt: latest }
          } catch {
            return { ok: false, reason: 'unknown' }
          }
        },
      )
    },
  })
}
export type ProvisioningEngine = ReturnType<typeof createProvisioningEngine>
