import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import {
  openFarmPauseControl,
  PAUSE_READMIT_DEBOUNCE_MS,
  type FarmPauseControlState,
} from '../../apps/farm/app/utils/webrtc/farm-pause-control.ts'
import {
  controlBindingHash,
  encodeControlProof,
  signControlSessionProof,
} from '../../packages/farm-protocol/src/control-session-binding.ts'
import { decodeCommandV2 } from '../../packages/farm-protocol/src/command-v2.ts'
import { signPauseCapability } from '../../packages/farm-protocol/src/pause-capability.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import type { PauseCommandMessage } from '../../packages/connector/src/webrtc/pause-control-session.ts'

const digest = () => randomBytes(32).toString('base64url')
async function waitFor(condition: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for state')
    await new Promise((resolve) => setImmediate(resolve))
  }
}

type Options = Parameters<typeof openFarmPauseControl>[0]
type SignallingOptions = NonNullable<
  Parameters<NonNullable<Options['createSignalling']>>[1]
>

/**
 * Real keys and signatures; the issuer and the transport are local doubles.
 * The issuer grants `grants[n]` to the n-th admission, the last one repeating.
 */
async function fixture(grants: string[][]) {
  const browser = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const issuer = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const connector = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const jwk = await crypto.subtle.exportKey('jwk', browser.publicKey)
  const { publicKey, thumbprint } = await validateBrowserDevicePublicKey({
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
  })
  const spki = Buffer.from(
    await crypto.subtle.exportKey('spki', connector.publicKey),
  )
  const now = Date.now()
  const binding = {
    v: 1 as const,
    purpose: 'pause-rtc' as const,
    transport_id: randomUUID(),
    farm_id: randomUUID(),
    agent_id: randomUUID(),
    account_id: 'legacy_account',
    key_id: randomUUID(),
    assignment_id: randomUUID(),
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
    issued_at: now,
    expires_at: now + 30000,
    offer_sha256: digest(),
    answer_sha256: digest(),
    browser_dtls: Array(32).fill('AA').join(':'),
    connector_dtls: Array(32).fill('BB').join(':'),
  }
  const proof = async (role: 'browser' | 'connector') =>
    encodeControlProof({
      v: 1,
      role,
      binding,
      signature: await signControlSessionProof(
        binding,
        role,
        role === 'browser' ? browser.privateKey : connector.privateKey,
      ),
    })
  const browserProofWire = await proof('browser')
  const connectorProofWire = await proof('connector')
  const bindingHash = await controlBindingHash(binding)
  const states: FarmPauseControlState[] = []
  const commands: PauseCommandMessage[] = []
  const transports: SignallingOptions[] = []
  let closedTransports = 0
  let admissions = 0
  let clock = Date.now()
  const nonce = digest()
  const control = openFarmPauseControl({
    accountId: binding.account_id,
    farmId: binding.farm_id,
    keyId: binding.key_id,
    agentId: binding.agent_id,
    assignmentId: binding.assignment_id,
    now: () => clock,
    async resolveKey() {
      return {
        publicKey,
        privateKey: browser.privateKey,
        origin: binding.origin,
        audience: binding.audience,
      }
    },
    onState: (state) => states.push(state),
    createSignalling(_scope, value) {
      transports.push(value)
      return {
        start: () => Promise.resolve(),
        close: () => {
          closedTransports++
        },
        dispose: () => Promise.resolve(),
        sendPhase: () => true,
        sendCommand: (message) => {
          commands.push(message)
          return true
        },
      }
    },
    issuer: {
      async challenge({ admissionNonce }) {
        return {
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
          issued_at: Date.now(),
          expires_at: Date.now() + 8000,
        }
      },
      async capability() {
        const actions = grants[Math.min(admissions++, grants.length - 1)]!
        const issuedAt = Date.now()
        return signPauseCapability(
          {
            v: 1,
            purpose: 'pause-authority',
            capability_id: randomUUID(),
            kid: 'issuer-1',
            issuer: 'farm:issuer',
            audience: binding.audience,
            origin: binding.origin,
            issued_at: issuedAt,
            expires_at: Math.min(issuedAt + 30000, binding.expires_at),
            account_id: binding.account_id,
            role: 'operator',
            farm_id: binding.farm_id,
            agent_id: binding.agent_id,
            key_id: binding.key_id,
            assignment_id: binding.assignment_id,
            transport_id: binding.transport_id,
            browser_public_key: publicKey,
            browser_thumbprint: thumbprint,
            connector_fingerprint: binding.connector_fingerprint,
            credential_jti: binding.credential_jti,
            printer_key: 'printer-key',
            control_binding_sha256: bindingHash,
            admission_nonce: nonce,
            actions: actions as never,
          },
          issuer.privateKey,
        )
      },
    },
  })
  async function admit(index: number) {
    await waitFor(() => transports.length > index)
    const transport = transports[index]!
    transport.onProofsReady?.({
      binding,
      deadlineMonoMs: performance.now() + 30000,
      browserProofWire,
      connectorProofWire,
    })
    transport.onPhase?.({
      v: 1,
      transport_id: binding.transport_id,
      seq: 1,
      t: 'control.admission-nonce',
      admission_nonce: nonce,
      issued_at: Date.now(),
      expires_at: Date.now() + 8000,
    })
  }
  return {
    control,
    states,
    commands,
    transports,
    admit,
    closed: () => closedTransports,
    advance: (ms: number) => {
      clock += ms
    },
    result(commandId: string) {
      transports.at(-1)!.onData?.({
        v: 1,
        transport_id: binding.transport_id,
        seq: 4,
        t: 'control.result',
        command_id: commandId,
        outcome: 'applied',
      })
    },
  }
}

const START = ['pause', 'start_print']

describe('pause capability refresh on advertised controls', () => {
  test('a capability without start is re-admitted once when fresh controls add it, then start is allowed', async () => {
    const f = await fixture([['pause'], START])
    await f.admit(0)
    await waitFor(() => f.states.at(-1)?.kind === 'ready')
    expect(f.control.admittedActions).toEqual(['pause'])

    // Fresh controls with start: one re-admission over a new transport.
    expect(f.control.controlsChanged(START, true)).toBe(true)
    expect(f.states.at(-1)).toEqual({ kind: 'connecting' })
    expect(f.closed()).toBe(1)
    await f.admit(1)
    await waitFor(() => f.states.at(-1)?.kind === 'ready')
    expect(f.transports).toHaveLength(2)
    expect(f.control.admittedActions).toEqual(START)

    // Debounced: the same controls do not loop, even once the gap has passed.
    expect(f.control.controlsChanged(START, true)).toBe(false)
    f.advance(PAUSE_READMIT_DEBOUNCE_MS + 1)
    expect(f.control.controlsChanged(START, true)).toBe(false)
    expect(f.transports).toHaveLength(2)

    const outcome = f.control.issueControlCommand('start_print', {
      file: 'a.gcode',
    })
    await waitFor(() => f.commands.length === 1)
    const command = decodeCommandV2(f.commands[0]!.wire)
    expect(command.action).toBe('start_print')
    f.result(command.cmd_id)
    expect(await outcome).toBe('applied')
    expect(f.commands).toHaveLength(1)
    await f.control.dispose()
  })

  test('stale or unchanged controls neither re-admit nor allow start', async () => {
    const f = await fixture([['pause']])
    await f.admit(0)
    await waitFor(() => f.states.at(-1)?.kind === 'ready')

    // Stale controls: no re-admission.
    expect(f.control.controlsChanged(START, false)).toBe(false)
    // Controls the capability already covers, or missing controls: nothing.
    expect(f.control.controlsChanged(['pause'], true)).toBe(false)
    expect(f.control.controlsChanged(undefined, true)).toBe(false)
    expect(f.transports).toHaveLength(1)
    expect(f.closed()).toBe(0)

    // Without a refresh the capability refuses start and sends nothing.
    expect(await f.control.issueControlCommand('start_print')).toBe('rejected')
    expect(f.commands).toHaveLength(0)
    await f.control.dispose()
  })

  test('a refresh never runs while a command is in flight or after the end', async () => {
    const f = await fixture([['pause']])
    await f.admit(0)
    await waitFor(() => f.states.at(-1)?.kind === 'ready')
    const pending = f.control.pause()
    await waitFor(() => f.commands.length === 1)
    expect(f.control.controlsChanged(START, true)).toBe(false)
    f.result(decodeCommandV2(f.commands[0]!.wire).cmd_id)
    await pending
    expect(f.control.controlsChanged(START, true)).toBe(false)
    expect(f.transports).toHaveLength(1)
    await f.control.dispose()
  })
})
