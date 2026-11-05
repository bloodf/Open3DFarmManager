import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import {
  openCommandJournal,
  closeCommandJournal,
  readCommandOutcome,
} from '../../packages/connector/src/control/command-journal.ts'
import { createPauseDispatcher } from '../../packages/connector/src/control/pause-dispatcher.ts'
import {
  createPrinterBindingRegistry,
  readPrinterBinding,
} from '../../packages/connector/src/control/printer-binding.ts'
import {
  signCommandV2,
  encodeCommandV2,
} from '../../packages/farm-protocol/src/command-v2.ts'
async function commandFixture() {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const { kty, crv, x, y } = await crypto.subtle.exportKey(
    'jwk',
    pair.publicKey,
  )
  const { validateBrowserDevicePublicKey } = await import(
    '../../packages/farm-protocol/src/browser-device-proof.ts'
  )
  const { publicKey } = await validateBrowserDevicePublicKey({ kty, crv, x, y })
  const command = {
    v: 2 as const,
    purpose: 'printer-pause' as const,
    cmd_id: randomUUID(),
    farm_id: randomUUID(),
    agent_id: randomUUID(),
    account_id: 'legacy_account',
    key_id: randomUUID(),
    transport_id: randomUUID(),
    capability_id: randomUUID(),
    assignment_id: randomUUID(),
    action: 'pause' as const,
    args: {},
    issued_at: 1000,
    expires_at: 6000,
    nonce: randomBytes(16).toString('base64url'),
  }
  return { pair, publicKey, command }
}

async function authorityFixture() {
  const { pair, publicKey, command } = await commandFixture()
  const { validateBrowserDevicePublicKey } = await import(
    '../../packages/farm-protocol/src/browser-device-proof.ts'
  )
  const { thumbprint } = await validateBrowserDevicePublicKey(publicKey)
  const issuer = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const connector = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const spki = Buffer.from(
    await crypto.subtle.exportKey('spki', connector.publicKey),
  )
  const { createHash } = await import('node:crypto')
  const digest = () => randomBytes(32).toString('base64url')
  const binding = {
    v: 1 as const,
    purpose: 'pause-rtc' as const,
    transport_id: command.transport_id,
    farm_id: command.farm_id,
    agent_id: command.agent_id,
    account_id: command.account_id,
    key_id: command.key_id,
    assignment_id: command.assignment_id,
    browser_public_key: publicKey,
    browser_thumbprint: thumbprint,
    connector_public_key_spki: spki.toString('base64url'),
    connector_fingerprint:
      'SHA256:' + createHash('sha256').update(spki).digest('base64url'),
    credential_jti: randomUUID(),
    origin: 'https://farm.example',
    audience: 'open3dfarmmanager:pause',
    browser_nonce: digest(),
    connector_nonce: digest(),
    issued_at: 1000,
    expires_at: 30000,
    offer_sha256: digest(),
    answer_sha256: digest(),
    browser_dtls: Array(32).fill('AA').join(':'),
    connector_dtls: Array(32).fill('BB').join(':'),
  }
  const { controlBindingHash } = await import(
    '../../packages/farm-protocol/src/control-session-binding.ts'
  )
  const bindingHash = await controlBindingHash(binding),
    admissionNonce = digest()
  const capability = {
    v: 1 as const,
    purpose: 'pause-authority' as const,
    capability_id: command.capability_id,
    kid: 'issuer-1',
    issuer: 'farm:issuer',
    audience: binding.audience,
    origin: binding.origin,
    issued_at: 1000,
    expires_at: 30000,
    account_id: command.account_id,
    role: 'operator' as const,
    farm_id: binding.farm_id,
    agent_id: binding.agent_id,
    key_id: binding.key_id,
    assignment_id: binding.assignment_id,
    transport_id: binding.transport_id,
    browser_public_key: publicKey,
    browser_thumbprint: thumbprint,
    connector_fingerprint: binding.connector_fingerprint,
    credential_jti: binding.credential_jti,
    printer_key: 'é"\\'.repeat(32),
    control_binding_sha256: bindingHash,
    admission_nonce: admissionNonce,
    actions: ['pause'] as ['pause'],
  }
  const challenge = {
    v: 1 as const,
    purpose: 'pause-admission' as const,
    challenge_id: randomUUID(),
    farm_id: binding.farm_id,
    agent_id: binding.agent_id,
    key_id: binding.key_id,
    assignment_id: binding.assignment_id,
    transport_id: binding.transport_id,
    account_id: binding.account_id,
    browser_thumbprint: thumbprint,
    origin: binding.origin,
    audience: binding.audience,
    control_binding_sha256: bindingHash,
    admission_nonce: admissionNonce,
    issued_at: 1000,
    expires_at: 9000,
  }
  return {
    pair,
    publicKey,
    command,
    issuer,
    connector,
    binding,
    capability,
    challenge,
  }
}

type DriverWaiter = {
  count: number
  timer: ReturnType<typeof setTimeout> | undefined
  settle: (error: Error | null) => void
}

// Driver entry follows asynchronous signature verification. Tests that stop
// after entry must synchronize with the driver, not assume crypto finishes
// within a small real-time budget under parallel test load.
function releaseDriverWaiters(waiters: DriverWaiter[], reached: number): void {
  for (const waiter of [...waiters]) {
    if (reached < waiter.count) continue
    waiters.splice(waiters.indexOf(waiter), 1)
    waiter.settle(null)
  }
}

function waitForDriverCount(
  waiters: DriverWaiter[],
  reached: () => number,
  count: number,
  timeoutMs: number,
  label: string,
): Promise<void> {
  if (reached() >= count) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const waiter: DriverWaiter = {
      count,
      timer: undefined,
      settle: (error) => {
        if (waiter.timer !== undefined) clearTimeout(waiter.timer)
        if (error) reject(error)
        else resolve()
      },
    }
    waiter.timer = setTimeout(() => {
      const index = waiters.indexOf(waiter)
      if (index >= 0) waiters.splice(index, 1)
      waiter.settle(
        new Error(
          `${label}: the driver was not reached ${count} time(s) within ${timeoutMs}ms; the dispatch result deadline most likely preempted it`,
        ),
      )
    }, timeoutMs)
    waiters.push(waiter)
  })
}

async function fixture(shortCapability = false, resultTimeoutMs = 1000) {
  const f = await authorityFixture(),
    directory = mkdtempSync(join(tmpdir(), 'open3dfarm-pause-dispatch-'))
  let wall = 1000,
    mono = 1000,
    writes = 0
  let onClockSample: (() => void) | undefined
  let onMonotonicSample: (() => void) | undefined
  let onJournalClock: (() => void) | undefined
  let onDriverAbort: (() => void) | undefined
  const journal = openCommandJournal({
    directory,
    clock: () => {
      onJournalClock?.()
      return wall
    },
  })
  const bindings = createPrinterBindingRegistry({
    allowedOrigins: ['http://127.0.0.1:7125'],
  })
  const printerBinding = bindings.provision({
    assignment_id: f.binding.assignment_id,
    farm_id: f.binding.farm_id,
    agent_id: f.binding.agent_id,
    printer_key: f.capability.printer_key,
    moonraker_origin: 'http://127.0.0.1:7125',
  })
  let state = {
    assignmentId: f.binding.assignment_id,
    printerKey: f.capability.printer_key,
    connectionGeneration: 1,
    sequence: 1,
    ready: true,
    printState: 'printing' as
      | 'printing'
      | 'paused'
      | 'idle'
      | 'error'
      | 'unknown',
    readyObservedMono: 1000,
    printStateObservedMono: 1000,
    receivedMono: 1000,
  }
  let mode:
    | 'normal'
    | 'hang-preparation'
    | 'hang-close'
    | 'unconfirmed'
    | 'hang-after-send'
    | 'hang-before-send'
    | 'revoke-before-send'
    | 'double-guard'
    | 'expire-before-send'
    | 'finish-fail'
    | 'equal-paused-time'
    | 'expire-after-send' = 'normal'
  const unblocks: Array<() => void> = []
  let lateGuard: (() => boolean) | undefined
  const preparationWaiters: DriverWaiter[] = []
  const closeWaiters: DriverWaiter[] = []
  let closeCount = 0
  let preparationCount = 0
  let preparationSignal: AbortSignal | undefined
  let driverEntryCount = 0
  let driverCompletionCount = 0
  const driverEntryWaiters: DriverWaiter[] = []
  const driverCompletionWaiters: DriverWaiter[] = []
  let postCommit: (() => void) | undefined
  let postCommitPhase: 'wall' | 'mono' = 'wall'
  let resultClock: (() => void) | undefined
  const driver = {
    prepare: async ({
      binding,
      signal,
    }: {
      binding: typeof printerBinding
      signal: AbortSignal
    }) => {
      preparationCount++
      releaseDriverWaiters(preparationWaiters, preparationCount)
      preparationSignal = signal
      if (mode === 'hang-preparation')
        await new Promise<void>((resolve) => {
          unblocks.push(resolve)
        })
      const mapping = readPrinterBinding(binding)
      if (mapping)
        dispatcher.observe(binding, {
          ...state,
          assignmentId: mapping.assignment_id,
          printerKey: mapping.printer_key,
        })
      return { connectionGeneration: state.connectionGeneration }
    },
    closeAttempt: async () => {
      closeCount++
      releaseDriverWaiters(closeWaiters, closeCount)
      if (mode === 'hang-close')
        await new Promise<void>((resolve) => {
          unblocks.push(resolve)
        })
    },
    pauseOnce: async ({
      beforeSend,
      signal,
    }: {
      beforeSend: () => boolean
      signal: AbortSignal
    }) => {
      signal.addEventListener('abort', () => onDriverAbort?.(), { once: true })
      if (mode === 'hang-before-send') lateGuard = beforeSend
      // The driver was reached. This is the only deterministic proof that the
      // send boundary exists, and it is published before any await so a test
      // can order an explicit stop strictly after it.
      driverEntryCount += 1
      releaseDriverWaiters(driverEntryWaiters, driverEntryCount)
      try {
        if (mode === 'hang-before-send') {
          await new Promise<void>((resolve) => {
            unblocks.push(resolve)
          })
          if (beforeSend()) writes++
          return { acknowledged: true }
        }
        if (mode === 'revoke-before-send' && result.ok)
          dispatcher.revoke(result.handle)
        if (mode === 'expire-before-send') {
          wall += 5000
          mono += 5000
        }
        if (beforeSend()) writes++
        if (mode === 'double-guard' && beforeSend()) writes++
        if (mode === 'hang-after-send')
          await new Promise<void>((resolve) => {
            unblocks.push(resolve)
          })
        return { acknowledged: true }
      } finally {
        driverCompletionCount += 1
        releaseDriverWaiters(driverCompletionWaiters, driverCompletionCount)
      }
    },
    waitForPaused: async () => {
      if (mode === 'finish-fail') {
        const db = new DatabaseSync(join(directory, 'pause-commands.sqlite'))
        db.exec(
          "CREATE TRIGGER fail_finish BEFORE UPDATE ON pause_commands BEGIN SELECT RAISE(ABORT,'synthetic'); END",
        )
        db.close()
      }
      onMonotonicSample = () => {
        const action = resultClock
        resultClock = undefined
        action?.()
      }
      const sent = mono
      const delta = mode === 'expire-after-send' ? 100 : 1
      wall += delta
      mono += delta
      return {
        ...state,
        readyObservedMono: mono,
        printState:
          mode === 'unconfirmed' ? ('printing' as const) : ('paused' as const),
        sequence: 2,
        receivedMono: mono,
        printStateObservedMono: mode === 'equal-paused-time' ? sent : mono,
      }
    },
  }
  function runPostCommit(phase: 'wall' | 'mono') {
    if (postCommitPhase !== phase) return
    if (postCommit) {
      const db = new DatabaseSync(join(directory, 'pause-commands.sqlite'))
      const row = db
        .prepare(
          "SELECT count(*) AS n FROM pause_commands WHERE status='write-started'",
        )
        .get()
      db.close()
      if (row?.n) {
        const action = postCommit
        postCommit = undefined
        action()
      }
    }
  }
  const dispatcher = createPauseDispatcher({
    authority: {
      issuers: [
        {
          issuer: f.capability.issuer,
          kid: f.capability.kid,
          publicKey: f.issuer.publicKey,
        },
      ],
    },
    clock: {
      wallNow: () => {
        onClockSample?.()
        runPostCommit('wall')
        return wall
      },
      monotonicNow: () => {
        onMonotonicSample?.()
        runPostCommit('mono')
        return mono
      },
    },
    journal,
    driver,
    resultTimeoutMs,
  })
  dispatcher.observe(printerBinding, state)
  const controls = await import(
    '../../packages/farm-protocol/src/control-session-binding.ts'
  )
  const caps = await import(
    '../../packages/farm-protocol/src/pause-capability.ts'
  )
  const peer = dispatcher.createPeer(1)
  const admission = dispatcher.beginAdmission({
    binding: f.binding,
    printerBinding,
    peer: peer.peer,
  })
  const nonce = admission.challenge.admissionNonce
  const capability = await caps.signPauseCapability(
    {
      ...f.capability,
      expires_at: shortCapability ? 1100 : f.capability.expires_at,
      admission_nonce: nonce,
    },
    f.issuer.privateKey,
  )
  const proof = await caps.signPauseAdmissionProof(
    { ...f.challenge, admission_nonce: nonce },
    f.pair.privateKey,
  )
  const bsig = await controls.signControlSessionProof(
    f.binding,
    'browser',
    f.pair.privateKey,
  )
  const csig = await controls.signControlSessionProof(
    f.binding,
    'connector',
    f.connector.privateKey,
  )
  const result = await dispatcher.admit(admission.token, {
    capabilityWire: caps.encodePauseCapability(capability),
    admissionProofWire: caps.encodePauseAdmissionProof(proof),
    browserProofWire: controls.encodeControlProof({
      v: 1,
      role: 'browser',
      binding: f.binding,
      signature: bsig,
    }),
    connectorProofWire: controls.encodeControlProof({
      v: 1,
      role: 'connector',
      binding: f.binding,
      signature: csig,
    }),
  })
  assert.ok(result.ok)
  async function additional() {
    const assignment_id = randomUUID(),
      printer_key = 'printer-' + randomUUID()
    const binding = { ...f.binding, assignment_id }
    const local = bindings.provision({
      assignment_id,
      farm_id: binding.farm_id,
      agent_id: binding.agent_id,
      printer_key,
      moonraker_origin: 'http://127.0.0.1:7125',
    })
    dispatcher.observe(local, {
      ...state,
      assignmentId: assignment_id,
      printerKey: printer_key,
    })
    const a = dispatcher.beginAdmission({
      binding,
      printerBinding: local,
      peer: dispatcher.createPeer(1).peer,
    })
    const hash = await controls.controlBindingHash(binding),
      nonce = a.challenge.admissionNonce
    const capability = await caps.signPauseCapability(
      {
        ...f.capability,
        assignment_id,
        printer_key,
        control_binding_sha256: hash,
        admission_nonce: nonce,
        capability_id: randomUUID(),
      },
      f.issuer.privateKey,
    )
    const proof = await caps.signPauseAdmissionProof(
      {
        ...f.challenge,
        assignment_id,
        control_binding_sha256: hash,
        admission_nonce: nonce,
      },
      f.pair.privateKey,
    )
    const bsig = await controls.signControlSessionProof(
        binding,
        'browser',
        f.pair.privateKey,
      ),
      csig = await controls.signControlSessionProof(
        binding,
        'connector',
        f.connector.privateKey,
      )
    const accepted = await dispatcher.admit(a.token, {
      capabilityWire: caps.encodePauseCapability(capability),
      admissionProofWire: caps.encodePauseAdmissionProof(proof),
      browserProofWire: controls.encodeControlProof({
        v: 1,
        role: 'browser',
        binding,
        signature: bsig,
      }),
      connectorProofWire: controls.encodeControlProof({
        v: 1,
        role: 'connector',
        binding,
        signature: csig,
      }),
    })
    assert.ok(accepted.ok)
    const command = await signCommandV2(
      {
        ...f.command,
        cmd_id: randomUUID(),
        assignment_id,
        capability_id: capability.capability_id,
        nonce: randomBytes(16).toString('base64url'),
      },
      f.pair.privateKey,
    )
    return {
      wire: encodeCommandV2(command),
      capability: accepted.handle,
      printerBinding: local,
      assignment_id,
      printer_key,
    }
  }
  const signed = await signCommandV2(
    { ...f.command, expires_at: shortCapability ? 1100 : f.command.expires_at },
    f.pair.privateKey,
  )
  return {
    f,
    dispatcher,
    printerBinding,
    driver,
    additional,
    preparationCount: () => preparationCount,
    waitForPreparation: () =>
      waitForDriverCount(
        preparationWaiters,
        () => preparationCount,
        1,
        5000,
        'preparation',
      ),
    waitForClose: () =>
      waitForDriverCount(closeWaiters, () => closeCount, 1, 5000, 'close'),
    preparationSignal: () => preparationSignal,
    driverEntryCount: () => driverEntryCount,
    driverCompletionCount: () => driverCompletionCount,
    waitForDriverEntry: (count = 1, timeoutMs = 5000) =>
      waitForDriverCount(
        driverEntryWaiters,
        () => driverEntryCount,
        count,
        timeoutMs,
        'driver entry',
      ),
    waitForDriverCompletion: (count = 1, timeoutMs = 5000) =>
      waitForDriverCount(
        driverCompletionWaiters,
        () => driverCompletionCount,
        count,
        timeoutMs,
        'driver completion',
      ),
    wire: encodeCommandV2(signed),
    handle: result.handle,
    peer,
    journal,
    directory,
    setJournalClock: (action: () => void) => {
      onJournalClock = action
    },
    setDriverAbort: (action: () => void) => {
      onDriverAbort = action
    },
    retire: () => bindings.retire(printerBinding),
    setResultClock: (action: () => void) => {
      resultClock = action
    },
    setClockSample: (action: () => void) => {
      onClockSample = action
    },
    setPostCommit: (action: () => void, phase: 'wall' | 'mono' = 'wall') => {
      postCommit = action
      postCommitPhase = phase
    },
    setMode: (value: typeof mode) => {
      mode = value
    },
    unblock: () => {
      for (const release of unblocks) release()
    },
    lateGuard: () => lateGuard?.(),
    getWrites: () => writes,
    setState: (value: typeof state) => {
      state = value
      dispatcher.observe(printerBinding, value)
    },
    getState: () => state,
    advance: (n: number) => {
      wall += n
      mono += n
    },
    revoke: () => {
      dispatcher.revoke(result.handle)
    },
    cleanup: () => {
      dispatcher.close()
      closeCommandJournal(journal)
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

test('real verified capability and P-256 command reach one guarded synthetic pause and fresh observation', async () => {
  const f = await fixture()
  try {
    const result = await f.dispatcher.dispatch({
      wire: f.wire,
      capability: f.handle,
      printerBinding: f.printerBinding,
    })
    assert.equal(result.kind, 'applied', JSON.stringify(result))
    assert.equal(f.getWrites(), 1)
    const again = await f.dispatcher.dispatch({
      wire: f.wire,
      capability: f.handle,
      printerBinding: f.printerBinding,
    })
    assert.deepEqual(again, { kind: 'rejected', reason: 'replay' })
    assert.equal(f.getWrites(), 1)
  } finally {
    f.cleanup()
  }
})

test('forged authority, modified command, revoked capability and stale fields never write', async () => {
  for (const scenario of [
    'forged',
    'tamper',
    'revoked',
    'stale-ready',
    'stale-state',
    'expired',
  ]) {
    const f = await fixture()
    try {
      let wire = f.wire,
        capability: unknown = f.handle
      if (scenario === 'forged') capability = {}
      if (scenario === 'tamper')
        wire = wire.replace('legacy_account', 'other_account')
      if (scenario === 'revoked') f.revoke()
      if (scenario === 'stale-ready') {
        f.advance(2001)
        f.setState({
          ...f.getState(),
          printStateObservedMono: 3001,
          receivedMono: 3001,
        })
      }
      if (scenario === 'stale-state') {
        f.advance(2001)
        f.setState({
          ...f.getState(),
          readyObservedMono: 3001,
          receivedMono: 3001,
        })
      }
      if (scenario === 'expired') f.advance(5000)
      const result = await f.dispatcher.dispatch({
        wire,
        capability,
        printerBinding: f.printerBinding,
      })
      assert.equal(
        result.kind,
        scenario.startsWith('stale-') ? 'not-sent' : 'rejected',
        scenario,
      )
      assert.equal(f.getWrites(), 0, scenario)
      if (['forged', 'tamper', 'revoked', 'expired'].includes(scenario))
        assert.equal(f.preparationCount(), 0, scenario)
    } finally {
      f.cleanup()
    }
  }
})

test('RPC acknowledgement without fresh paused state remains unknown and blocks retry', async () => {
  const f = await fixture()
  f.setMode('unconfirmed')
  try {
    const result = await f.dispatcher.dispatch({
      wire: f.wire,
      capability: f.handle,
      printerBinding: f.printerBinding,
    })
    assert.equal(result.kind, 'outcome-unknown')
    assert.equal(f.getWrites(), 1)
    assert.equal(
      readCommandOutcome(f.journal, f.f.command.cmd_id)?.status,
      'outcome-unknown',
    )
    assert.equal(
      (
        await f.dispatcher.dispatch({
          wire: f.wire,
          capability: f.handle,
          printerBinding: f.printerBinding,
        })
      ).kind,
      'rejected',
    )
    assert.equal(f.getWrites(), 1)
  } finally {
    f.cleanup()
  }
})

test('late driver completion cannot rewrite unknown or invoke a late send guard', async () => {
  for (const mode of ['hang-before-send', 'hang-after-send'] as const) {
    const f = await fixture()
    f.setMode(mode)
    try {
      const result = await f.dispatcher.dispatch({
        wire: f.wire,
        capability: f.handle,
        printerBinding: f.printerBinding,
      })
      assert.equal(
        result.kind,
        mode === 'hang-before-send' ? 'not-sent' : 'outcome-unknown',
      )
      if (mode === 'hang-before-send') assert.equal(f.lateGuard(), false)
      const writes = f.getWrites()
      f.unblock()
      await f.waitForDriverCompletion(1)
      f.dispatcher.close()
      await f.dispatcher.settled
      assert.equal(f.getWrites(), writes)
      const stored = readCommandOutcome(f.journal, f.f.command.cmd_id)
      assert.equal(
        stored?.status,
        mode === 'hang-before-send' ? 'not-sent' : 'outcome-unknown',
      )
    } finally {
      f.cleanup()
    }
  }
})

test('revocation at send boundary prevents write and guard cannot authorize twice', async () => {
  for (const mode of ['revoke-before-send', 'double-guard'] as const) {
    const f = await fixture()
    f.setMode(mode)
    try {
      const result = await f.dispatcher.dispatch({
        wire: f.wire,
        capability: f.handle,
        printerBinding: f.printerBinding,
      })
      if (mode === 'revoke-before-send') {
        assert.equal(f.getWrites(), 0)
        assert.equal(result.kind, 'not-sent')
      } else {
        assert.equal(f.getWrites(), 1)
        assert.equal(result.kind, 'outcome-unknown')
      }
    } finally {
      f.cleanup()
    }
  }
})

test('deadline at send and failed result persistence never produce false success', async () => {
  for (const mode of ['expire-before-send', 'finish-fail'] as const) {
    const f = await fixture()
    f.setMode(mode)
    try {
      const result = await f.dispatcher.dispatch({
        wire: f.wire,
        capability: f.handle,
        printerBinding: f.printerBinding,
      })
      if (mode === 'expire-before-send') {
        assert.equal(result.kind, 'not-sent')
        assert.equal(f.getWrites(), 0)
      } else {
        assert.equal(result.kind, 'outcome-unknown')
        assert.equal(f.getWrites(), 1)
        assert.equal(
          readCommandOutcome(f.journal, f.f.command.cmd_id)?.status,
          'outcome-unknown',
        )
      }
    } finally {
      f.cleanup()
    }
  }
})

test('close or abort seals a delayed send boundary', async () => {
  for (const stop of ['close', 'abort'] as const) {
    // The dispatcher arms its result deadline with a real timer when the
    // dispatch starts, while the driver is only reached after the threadpool
    // backed signature verification completes. This scenario waits for the
    // driver entry signal instead of polling a flag, so the stop below is
    // provably applied after the driver was reached, and it runs with the
    // production maximum budget to leave room for signature verification under test load.
    const f = await fixture(false, 5000)
    f.setMode('hang-before-send')
    const abort = new AbortController()
    try {
      const pending = f.dispatcher.dispatch({
        wire: f.wire,
        capability: f.handle,
        printerBinding: f.printerBinding,
        signal: abort.signal,
      })
      await f.waitForDriverEntry(1)
      if (stop === 'close') f.dispatcher.close()
      else abort.abort()
      assert.equal((await pending).kind, 'not-sent')
      assert.equal(f.lateGuard(), false)
      f.unblock()
      await f.waitForDriverCompletion(1)
      assert.equal(f.getWrites(), 0)
    } finally {
      f.cleanup()
    }
  }
})

test(
  'a result deadline elapsed during signature verification never enters the driver',
  { timeout: 5000 },
  async () => {
    const f = await fixture(false, 50)
    f.setMode('hang-before-send')
    try {
      const pending = f.dispatcher.dispatch({
        wire: f.wire,
        capability: f.handle,
        printerBinding: f.printerBinding,
      })
      // dispatch awaits WebCrypto before driver entry. Advance its trusted clock
      // before that continuation, independent of real timer/poll phase ordering.
      f.advance(51)
      const result = await pending
      // A timer before the durable claim rejects; the post-claim clock guard
      // records not-sent. Both must stop before invoking the driver.
      assert.equal(result.reason, 'deadline')
      assert.ok(result.kind === 'rejected' || result.kind === 'not-sent')
      assert.equal(f.driverEntryCount(), 0)
      assert.equal(f.getWrites(), 0)
    } finally {
      f.unblock()
      f.cleanup()
    }
  },
)

test('same assignment has no queue and timed-out work retains the global eight-slot bound', async () => {
  const f = await fixture(false, 1000)
  f.setMode('hang-before-send')
  try {
    const extra = await Promise.all(
      Array.from({ length: 8 }, () => f.additional()),
    )
    const first = {
      wire: f.wire,
      capability: f.handle,
      printerBinding: f.printerBinding,
    }
    const work = [first, ...extra.slice(0, 7)].map((input) =>
      f.dispatcher.dispatch(input),
    )
    assert.deepEqual(await f.dispatcher.dispatch(first), {
      kind: 'rejected',
      reason: 'busy',
    })
    const ninth = extra[7]
    assert.ok(ninth)
    assert.deepEqual(await f.dispatcher.dispatch(ninth), {
      kind: 'rejected',
      reason: 'busy',
    })
    await f.waitForDriverEntry(8)
    const settled = await Promise.all(work)
    assert.equal(
      settled.every((result) => result.kind === 'not-sent'),
      true,
      JSON.stringify(settled),
    )
    assert.deepEqual(await f.dispatcher.dispatch(ninth), {
      kind: 'rejected',
      reason: 'busy',
    })
    f.unblock()
    await f.waitForDriverCompletion(8)
    assert.equal(f.getWrites(), 0)
  } finally {
    f.unblock()
    f.cleanup()
  }
})

test('post-send result requires a newer paused field but may finish after capability expiry', async () => {
  for (const mode of ['equal-paused-time', 'expire-after-send'] as const) {
    const f = await fixture(mode === 'expire-after-send')
    f.setMode(mode)
    try {
      const result = await f.dispatcher.dispatch({
        wire: f.wire,
        capability: f.handle,
        printerBinding: f.printerBinding,
      })
      assert.equal(
        result.kind,
        mode === 'equal-paused-time' ? 'outcome-unknown' : 'applied',
      )
      assert.equal(f.getWrites(), 1)
    } finally {
      f.cleanup()
    }
  }
})

test('last durable write-start commit is followed by revocation, connection, clock and close guards', async () => {
  for (const change of [
    'revocation',
    'connection',
    'stale',
    'expiry',
    'close',
    'abort',
  ] as const) {
    const f = await fixture(),
      abort = new AbortController()
    let observed = false
    try {
      f.setPostCommit(() => {
        observed = true
        if (change === 'revocation') f.revoke()
        if (change === 'connection')
          f.setState({ ...f.getState(), connectionGeneration: 2 })
        if (change === 'stale') f.advance(2001)
        if (change === 'expiry') f.advance(5000)
        if (change === 'close') f.dispatcher.close()
        if (change === 'abort') abort.abort()
      })
      const result = await f.dispatcher.dispatch({
        wire: f.wire,
        capability: f.handle,
        printerBinding: f.printerBinding,
        signal: abort.signal,
      })
      assert.equal(observed, true, change)
      assert.equal(result.kind, 'not-sent', change)
      assert.equal(f.getWrites(), 0, change)
    } finally {
      f.cleanup()
    }
  }
})

test('failed durable write-start commit prevents driver send', async () => {
  const f = await fixture(),
    db = new DatabaseSync(join(f.directory, 'pause-commands.sqlite'))
  try {
    db.exec(
      "CREATE TRIGGER fail_mark BEFORE UPDATE ON pause_commands BEGIN SELECT RAISE(ABORT,'synthetic'); END",
    )
    const result = await f.dispatcher.dispatch({
      wire: f.wire,
      capability: f.handle,
      printerBinding: f.printerBinding,
    })
    assert.equal(result.kind, 'outcome-unknown')
    assert.equal(f.getWrites(), 0)
  } finally {
    db.close()
    f.cleanup()
  }
})

test('final send clock cannot hide revocation, peer closure, generation change or observation invalidation', async () => {
  for (const change of [
    'revoke',
    'peer-close',
    'peer-generation',
    'disconnect',
    'disconnect-restore',
    'generation',
    'generation-restore',
    'idle',
    'not-ready',
  ] as const) {
    const f = await fixture()
    const db = new DatabaseSync(join(f.directory, 'pause-commands.sqlite'))
    let triggered = false
    try {
      f.setPostCommit(() => {
        triggered = true
        if (change === 'revoke') f.revoke()
        if (change === 'peer-close') f.peer.close()
        if (change === 'peer-generation') f.peer.advance(2)
        if (change === 'disconnect')
          f.dispatcher.observe(f.printerBinding, null)
        if (change === 'disconnect-restore') {
          f.dispatcher.observe(f.printerBinding, null)
          f.setState({ ...f.getState() })
        }
        if (change === 'generation-restore') {
          const original = { ...f.getState() }
          f.setState({ ...original, connectionGeneration: 2 })
          f.setState(original)
        }
        if (change === 'generation')
          f.setState({ ...f.getState(), connectionGeneration: 2 })
        if (change === 'idle')
          f.setState({ ...f.getState(), printState: 'idle' })
        if (change === 'not-ready')
          f.setState({ ...f.getState(), ready: false })
      }, 'mono')
      const result = await f.dispatcher.dispatch({
        wire: f.wire,
        capability: f.handle,
        printerBinding: f.printerBinding,
      })
      assert.equal(triggered, true, change)
      assert.equal(result.kind, 'not-sent', change)
      assert.equal(f.getWrites(), 0, change)
      assert.equal(
        db.prepare('SELECT status FROM pause_commands').get()?.status,
        'not-sent',
        change,
      )
    } finally {
      db.close()
      f.cleanup()
    }
  }
})

test('result clock cannot persist applied after revocation, peer change or disconnected observation', async () => {
  for (const change of [
    'revoke',
    'peer-close',
    'peer-generation',
    'disconnect',
    'disconnect-restore',
    'generation',
    'generation-restore',
  ] as const) {
    const f = await fixture()
    const db = new DatabaseSync(join(f.directory, 'pause-commands.sqlite'))
    let triggered = false
    // The dispatcher snapshots driver methods, so the fixture schedules its result-clock hook explicitly.
    f.setResultClock(() => {
      triggered = true
      if (change === 'revoke') f.revoke()
      if (change === 'peer-close') f.peer.close()
      if (change === 'peer-generation') f.peer.advance(2)
      if (change === 'disconnect') f.dispatcher.observe(f.printerBinding, null)
      if (change === 'disconnect-restore') {
        f.dispatcher.observe(f.printerBinding, null)
        f.setState({ ...f.getState() })
      }
      if (change === 'generation-restore') {
        const original = { ...f.getState() }
        f.setState({ ...original, connectionGeneration: 2 })
        f.setState(original)
      }
      if (change === 'generation')
        f.setState({ ...f.getState(), connectionGeneration: 2 })
    })
    try {
      const result = await f.dispatcher.dispatch({
        wire: f.wire,
        capability: f.handle,
        printerBinding: f.printerBinding,
      })
      assert.equal(triggered, true, change)
      assert.equal(f.getWrites(), 1, change)
      assert.equal(result.kind, 'outcome-unknown', change)
      assert.equal(
        db.prepare('SELECT status FROM pause_commands').get()?.status,
        'outcome-unknown',
        change,
      )
    } finally {
      db.close()
      f.cleanup()
    }
  }
})

test('observations are copied, scoped and invalidated on malformed or disconnected input', async () => {
  for (const mode of ['copy', 'scope', 'invalid', 'disconnect'] as const) {
    const f = await fixture()
    try {
      const observation = { ...f.getState() }
      assert.equal(f.dispatcher.observe(f.printerBinding, observation), true)
      if (mode === 'copy') observation.ready = false
      if (mode === 'scope')
        assert.equal(
          f.dispatcher.observe(f.printerBinding, {
            ...observation,
            assignmentId: randomUUID(),
          }),
          false,
        )
      if (mode === 'invalid')
        assert.equal(f.dispatcher.observe(f.printerBinding, {}), false)
      if (mode === 'disconnect')
        assert.equal(f.dispatcher.observe(f.printerBinding, null), false)
      const result = await f.dispatcher.dispatch({
        wire: f.wire,
        capability: f.handle,
        printerBinding: f.printerBinding,
      })
      assert.equal(result.kind, 'applied', mode)
      assert.equal(f.getWrites(), 1, mode)
    } finally {
      f.cleanup()
    }
  }
})

test('abort listeners run before the final result decision and cannot leave applied', async () => {
  for (const change of [
    'revoke',
    'peer-close',
    'disconnect',
    'retire',
  ] as const) {
    const f = await fixture()
    const db = new DatabaseSync(join(f.directory, 'pause-commands.sqlite'))
    let called = false
    f.setDriverAbort(() => {
      called = true
      if (change === 'revoke') f.revoke()
      if (change === 'peer-close') f.peer.close()
      if (change === 'disconnect') f.dispatcher.observe(f.printerBinding, null)
      if (change === 'retire') f.retire()
    })
    try {
      const result = await f.dispatcher.dispatch({
        wire: f.wire,
        capability: f.handle,
        printerBinding: f.printerBinding,
      })
      assert.equal(called, true, change)
      assert.equal(f.getWrites(), 1, change)
      assert.equal(result.kind, 'outcome-unknown', change)
      assert.equal(
        db.prepare('SELECT status FROM pause_commands').get()?.status,
        'outcome-unknown',
        change,
      )
    } finally {
      db.close()
      f.cleanup()
    }
  }
})

test('applied finalization invokes no journal clock after the final result sample', async () => {
  const f = await fixture()
  const db = new DatabaseSync(join(f.directory, 'pause-commands.sqlite'))
  let finalSample = false,
    lateClockCalls = 0
  f.setResultClock(() => {
    finalSample = true
    f.setJournalClock(() => {
      lateClockCalls++
      f.revoke()
    })
  })
  try {
    const result = await f.dispatcher.dispatch({
      wire: f.wire,
      capability: f.handle,
      printerBinding: f.printerBinding,
    })
    assert.equal(finalSample, true)
    assert.equal(lateClockCalls, 0)
    assert.equal(f.getWrites(), 1)
    assert.equal(result.kind, 'applied')
    assert.equal(
      db.prepare('SELECT status FROM pause_commands').get()?.status,
      'applied',
    )
  } finally {
    db.close()
    f.cleanup()
  }
})

test('journal write-start clock reentry is followed by pure authority checks', async () => {
  const f = await fixture()
  const db = new DatabaseSync(join(f.directory, 'pause-commands.sqlite'))
  let called = false
  f.setJournalClock(() => {
    if (
      db
        .prepare("SELECT status FROM pause_commands WHERE status='claimed'")
        .get()
    ) {
      called = true
      f.revoke()
    }
  })
  try {
    const result = await f.dispatcher.dispatch({
      wire: f.wire,
      capability: f.handle,
      printerBinding: f.printerBinding,
    })
    assert.equal(called, true)
    assert.equal(f.getWrites(), 0)
    assert.equal(result.kind, 'not-sent')
    assert.equal(
      db.prepare('SELECT status FROM pause_commands').get()?.status,
      'not-sent',
    )
  } finally {
    db.close()
    f.cleanup()
  }
})

test(
  'aborted preparation returns promptly but retains its slot and journal until actual settlement',
  { timeout: 15000 },
  async () => {
    const f = await fixture(false, 5000)
    f.setMode('hang-preparation')
    const controller = new AbortController()
    const input = {
      wire: f.wire,
      capability: f.handle,
      printerBinding: f.printerBinding,
    }
    try {
      const command = f.dispatcher.dispatch({
        ...input,
        signal: controller.signal,
      })
      await f.waitForPreparation()
      controller.abort()
      assert.equal((await command).kind, 'not-sent')
      assert.equal(f.preparationSignal()?.aborted, true)
      assert.deepEqual(await f.dispatcher.dispatch(input), {
        kind: 'rejected',
        reason: 'busy',
      })
      assert.equal(
        readCommandOutcome(f.journal, f.f.command.cmd_id)?.status,
        'outcome-unknown',
      )
      f.dispatcher.close()
      let settled = false
      void f.dispatcher.settled.then(() => {
        settled = true
      })
      await Promise.resolve()
      assert.equal(settled, false)
      f.unblock()
      await f.dispatcher.settled
      assert.equal(
        readCommandOutcome(f.journal, f.f.command.cmd_id)?.status,
        'not-sent',
      )
      assert.equal(f.getWrites(), 0)
    } finally {
      f.unblock()
      f.cleanup()
    }
  },
)

test(
  'result deadline aborts unresolved preparation without releasing its assignment',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(false, 1000)
    t.mock.timers.enable({ apis: ['setTimeout'] })
    f.setMode('hang-preparation')
    const input = {
      wire: f.wire,
      capability: f.handle,
      printerBinding: f.printerBinding,
    }
    try {
      const pending = f.dispatcher.dispatch(input)
      await f.waitForPreparation()
      t.mock.timers.tick(1000)
      const result = await pending
      assert.equal(result.kind, 'not-sent')
      assert.equal(f.preparationSignal()?.aborted, true)
      assert.deepEqual(await f.dispatcher.dispatch(input), {
        kind: 'rejected',
        reason: 'busy',
      })
      f.dispatcher.close()
      f.unblock()
      await f.dispatcher.settled
      assert.equal(f.getWrites(), 0)
    } finally {
      f.unblock()
      f.cleanup()
    }
  },
)

test(
  'a slow driver close cannot delay the bounded result or release the journal',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(false, 1000)
    t.mock.timers.enable({ apis: ['setTimeout'] })
    f.setMode('hang-close')
    const input = {
      wire: f.wire,
      capability: f.handle,
      printerBinding: f.printerBinding,
    }
    try {
      const pending = f.dispatcher.dispatch(input)
      await f.waitForClose()
      t.mock.timers.tick(1000)
      const result = await pending
      assert.equal(result.kind, 'outcome-unknown')
      assert.equal(f.getWrites(), 1)
      assert.deepEqual(await f.dispatcher.dispatch(input), {
        kind: 'rejected',
        reason: 'busy',
      })
      assert.equal(
        readCommandOutcome(f.journal, f.f.command.cmd_id)?.status,
        'outcome-unknown',
      )
      f.dispatcher.close()
      f.unblock()
      await f.dispatcher.settled
      assert.equal(
        readCommandOutcome(f.journal, f.f.command.cmd_id)?.status,
        'outcome-unknown',
      )
    } finally {
      f.unblock()
      f.cleanup()
    }
  },
)

test(
  'original signed expiry cancels preparation before the longer result deadline',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(true, 1000)
    t.mock.timers.enable({ apis: ['setTimeout'] })
    f.setMode('hang-preparation')
    try {
      const pending = f.dispatcher.dispatch({
        wire: f.wire,
        capability: f.handle,
        printerBinding: f.printerBinding,
      })
      await f.waitForPreparation()
      t.mock.timers.tick(1000)
      const result = await pending
      assert.equal(result.kind, 'not-sent')
      assert.equal(f.preparationSignal()?.aborted, true)
      assert.equal(f.getWrites(), 0)
      f.dispatcher.close()
      f.unblock()
      await f.dispatcher.settled
    } finally {
      f.unblock()
      f.cleanup()
    }
  },
)

test('abort reentered from the journal claim returns a correlated not-sent result', async () => {
  const f = await fixture()
  const controller = new AbortController()
  f.setJournalClock(() => controller.abort())
  try {
    const result = await f.dispatcher.dispatch({
      wire: f.wire,
      capability: f.handle,
      printerBinding: f.printerBinding,
      signal: controller.signal,
    })
    assert.deepEqual(result, {
      kind: 'not-sent',
      cmdId: f.f.command.cmd_id,
      reason: 'aborted',
    })
    assert.equal(f.preparationCount(), 0)
    assert.equal(f.getWrites(), 0)
    f.dispatcher.close()
    await f.dispatcher.settled
    assert.equal(
      readCommandOutcome(f.journal, f.f.command.cmd_id)?.status,
      'not-sent',
    )
  } finally {
    f.cleanup()
  }
})
