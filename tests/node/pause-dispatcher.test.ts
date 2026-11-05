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

async function fixture(shortCapability = false) {
  const f = await authorityFixture(),
    directory = mkdtempSync(join(tmpdir(), 'open3dfarm-pause-dispatch-'))
  let wall = 1000,
    mono = 1000,
    writes = 0,
    allowed = true
  let onRevocationCheck: (() => void) | undefined
  let onPeerCheck: (() => void) | undefined
  let onClockSample: (() => void) | undefined
  const journal = openCommandJournal({ directory, clock: () => wall })
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
  let postCommit: (() => void) | undefined
  const driver = {
    pauseOnce: async ({ beforeSend }: { beforeSend: () => boolean }) => {
      if (mode === 'hang-before-send') {
        lateGuard = beforeSend
        await new Promise<void>((resolve) => {
          unblocks.push(resolve)
        })
        if (beforeSend()) writes++
        return { acknowledged: true }
      }
      if (mode === 'revoke-before-send') allowed = false
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
    },
    waitForPaused: async () => {
      if (mode === 'finish-fail') {
        const db = new DatabaseSync(join(directory, 'pause-commands.sqlite'))
        db.exec(
          "CREATE TRIGGER fail_finish BEFORE UPDATE ON pause_commands BEGIN SELECT RAISE(ABORT,'synthetic'); END",
        )
        db.close()
      }
      const sent = mono
      const delta = 1
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
        return wall
      },
      monotonicNow: () => mono,
    },
    journal,
    driver,
    localRevocations: {
      check: () => {
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
        onRevocationCheck?.()
        return allowed
      },
    },
    resultTimeoutMs: 50,
  })
  dispatcher.observe(printerBinding, state)
  const controls = await import(
    '../../packages/farm-protocol/src/control-session-binding.ts'
  )
  const caps = await import(
    '../../packages/farm-protocol/src/pause-capability.ts'
  )
  const admission = dispatcher.beginAdmission({
    binding: f.binding,
    printerBinding,
    peerGeneration: 1,
    currentPeerGeneration: () => {
      onPeerCheck?.()
      return 1
    },
  })
  const nonce = admission.challenge.admissionNonce
  const capability = await caps.signPauseCapability(
    {
      ...f.capability,
      expires_at: shortCapability ? 1001 : f.capability.expires_at,
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
      peerGeneration: 1,
      currentPeerGeneration: () => {
        onPeerCheck?.()
        return 1
      },
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
    { ...f.command, expires_at: shortCapability ? 1001 : f.command.expires_at },
    f.pair.privateKey,
  )
  return {
    f,
    dispatcher,
    printerBinding,
    driver,
    additional,
    wire: encodeCommandV2(signed),
    handle: result.handle,
    journal,
    directory,
    setPeerCheck: (action: () => void) => {
      onPeerCheck = action
    },
    setClockSample: (action: () => void) => {
      onClockSample = action
    },
    setRevocationCheck: (action: () => void) => {
      onRevocationCheck = action
    },
    setPostCommit: (action: () => void) => {
      postCommit = action
    },
    setMode: (value: typeof mode) => {
      mode = value
    },
    unblock: () => {
      for (const release of unblocks) release()
    },
    lateGuard: () => lateGuard?.(),
    hasLateGuard: () => lateGuard !== undefined,
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
      allowed = false
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
      assert.equal(result.kind, 'rejected', scenario)
      assert.equal(f.getWrites(), 0, scenario)
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
      await new Promise((resolve) => setTimeout(resolve, 20))
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
    const f = await fixture()
    f.setMode('hang-before-send')
    const abort = new AbortController()
    try {
      const pending = f.dispatcher.dispatch({
        wire: f.wire,
        capability: f.handle,
        printerBinding: f.printerBinding,
        signal: abort.signal,
      })
      const deadline = Date.now() + 1000
      while (!f.hasLateGuard()) {
        assert.ok(Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      if (stop === 'close') f.dispatcher.close()
      else abort.abort()
      assert.equal((await pending).kind, 'not-sent')
      assert.equal(f.lateGuard(), false)
      f.unblock()
      await new Promise((resolve) => setTimeout(resolve, 10))
      assert.equal(f.getWrites(), 0)
    } finally {
      f.cleanup()
    }
  }
})

test('same assignment has no queue and timed-out work retains the global eight-slot bound', async () => {
  const f = await fixture()
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
    const settled = await Promise.all(work)
    assert.equal(
      settled.every((result) => result.kind === 'not-sent'),
      true,
    )
    assert.deepEqual(await f.dispatcher.dispatch(ninth), {
      kind: 'rejected',
      reason: 'busy',
    })
    f.unblock()
    await new Promise((resolve) => setTimeout(resolve, 20))
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

test('final revocation callback cannot permit a send after local state or lifecycle invalidation', async () => {
  for (const change of [
    'connection',
    'idle',
    'not-ready',
    'abort',
    'close',
    'expiry',
  ] as const) {
    const f = await fixture(),
      abort = new AbortController()
    const db = new DatabaseSync(join(f.directory, 'pause-commands.sqlite'))
    let checks = 0,
      triggered = false
    try {
      f.setRevocationCheck(() => {
        const row = db
          .prepare(
            "SELECT status FROM pause_commands WHERE status = 'write-started'",
          )
          .get()
        if (!row || ++checks !== 3) return
        triggered = true
        if (change === 'connection')
          f.setState({ ...f.getState(), connectionGeneration: 2 })
        if (change === 'idle')
          f.setState({ ...f.getState(), printState: 'idle' })
        if (change === 'not-ready')
          f.setState({ ...f.getState(), ready: false })
        if (change === 'abort') abort.abort()
        if (change === 'close') f.dispatcher.close()
        if (change === 'expiry') f.advance(5000)
      })
      const result = await f.dispatcher.dispatch({
        wire: f.wire,
        capability: f.handle,
        printerBinding: f.printerBinding,
        signal: abort.signal,
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

test('final peer and clock callbacks cannot invalidate the latched printer state unnoticed', async () => {
  for (const phase of ['peer', 'clock'] as const) {
    const f = await fixture()
    const db = new DatabaseSync(join(f.directory, 'pause-commands.sqlite'))
    let checks = 0,
      triggered = false
    try {
      f.setRevocationCheck(() => {
        if (
          !db
            .prepare(
              "SELECT status FROM pause_commands WHERE status = 'write-started'",
            )
            .get() ||
          ++checks !== 3
        )
          return
        const change = () => {
          triggered = true
          f.setState({ ...f.getState(), ready: false })
        }
        if (phase === 'peer') f.setPeerCheck(change)
        else f.setClockSample(change)
      })
      const result = await f.dispatcher.dispatch({
        wire: f.wire,
        capability: f.handle,
        printerBinding: f.printerBinding,
      })
      assert.equal(triggered, true, phase)
      assert.equal(result.kind, 'not-sent', phase)
      assert.equal(f.getWrites(), 0, phase)
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
      assert.equal(result.kind, mode === 'copy' ? 'applied' : 'rejected', mode)
      assert.equal(f.getWrites(), mode === 'copy' ? 1 : 0, mode)
    } finally {
      f.cleanup()
    }
  }
})
