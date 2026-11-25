// SPDX-License-Identifier: AGPL-3.0-or-later
// Regressions for #870 and #873. Synthetic printer reports and local doubles
// only: no socket is opened and no printer is contacted.
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  openFarmPauseControl,
  type FarmPauseControlState,
} from '../../apps/farm/app/utils/webrtc/farm-pause-control.ts'
import {
  pauseCommandResultWaitMs,
  pauseResultDriverFamilyFromIdentity,
  type PauseResultDriverFamily,
} from '../../apps/farm/app/utils/webrtc/pause-command-client.ts'
import {
  controlBindingHash,
  encodeControlProof,
  signControlSessionProof,
} from '../../packages/farm-protocol/src/control-session-binding.ts'
import { decodeCommandV2 } from '../../packages/farm-protocol/src/command-v2.ts'
import { signPauseCapability } from '../../packages/farm-protocol/src/pause-capability.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import {
  controlRoleAllowed,
  type ExtendedControlAction,
} from '../../packages/farm-protocol/src/control-actions.ts'
import { createKobraXStatus } from '../../packages/connector/src/kobra-x/status.ts'
import { normalizeMoonrakerSnapshot } from '../../packages/connector/src/moonraker/normalize.ts'
import type { RawPrinterObservation } from '../../packages/connector/src/runtime/farm-snapshot-provider.ts'
import { createKobraXCollection } from '../../packages/connector/src/runtime/kobra-x-collection.ts'
import { runSignallingLifecycle } from '../../packages/connector/src/runtime/signalling.ts'
import type { PauseCommandMessage } from '../../packages/connector/src/webrtc/pause-control-session.ts'

const digest = () => randomBytes(32).toString('base64url')
// `setImmediate` and `Date` stay real while a test fakes `setTimeout`.
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
type Role = 'owner' | 'admin' | 'operator'

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/**
 * The Connector's real session lifecycle: one control session at a time, and a
 * new one listens only after the previous one ended and the retry delay passed.
 */
function connectorDouble() {
  const owner = new AbortController()
  let listening: (() => () => void) | undefined
  const running = runSignallingLifecycle({
    signal: owner.signal,
    credentialExpiresAt: Date.now() + 60_000,
    retryMinMs: 1000,
    retryMaxMs: 30_000,
    createSession(onTerminal, onAdmitted, onServed) {
      const claim = () => {
        listening = undefined
        onServed()
        return onTerminal
      }
      return {
        async start() {
          listening = claim
          onAdmitted()
        },
        close() {
          if (listening === claim) listening = undefined
        },
        async dispose() {},
      }
    },
  })
  cleanups.push(async () => {
    owner.abort()
    await running
  })
  /** Serves one browser peer; `undefined` while nothing is listening. */
  return () => listening?.()
}

/**
 * Real keys and signatures; the issuer and the transport are local doubles.
 * The issuer grants `grants[n]` to the n-th admission, the last one repeating.
 */
async function fixture(input: {
  grants: ExtendedControlAction[][]
  role?: Role
  driverFamily?: PauseResultDriverFamily
  serve?: ReturnType<typeof connectorDouble>
}) {
  const role = input.role ?? 'operator'
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
  const proof = async (side: 'browser' | 'connector') =>
    encodeControlProof({
      v: 1,
      role: side,
      binding,
      signature: await signControlSessionProof(
        binding,
        side,
        side === 'browser' ? browser.privateKey : connector.privateKey,
      ),
    })
  const browserProofWire = await proof('browser')
  const connectorProofWire = await proof('connector')
  const bindingHash = await controlBindingHash(binding)
  const states: FarmPauseControlState[] = []
  const commands: PauseCommandMessage[] = []
  const transports: SignallingOptions[] = []
  let admissions = 0
  const nonce = digest()
  const control = openFarmPauseControl({
    accountId: binding.account_id,
    farmId: binding.farm_id,
    keyId: binding.key_id,
    agentId: binding.agent_id,
    assignmentId: binding.assignment_id,
    ...(input.driverFamily ? { driverFamily: input.driverFamily } : {}),
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
      let end: (() => void) | undefined
      return {
        start() {
          if (!input.serve) return Promise.resolve()
          end = input.serve()
          return end ? Promise.resolve() : Promise.reject(Error('busy'))
        },
        close() {},
        // The Connector sees the session end only once disposal completes.
        dispose: () =>
          input.serve
            ? new Promise<void>((resolve) =>
                setTimeout(() => {
                  end?.()
                  resolve()
                }, 50),
              )
            : Promise.resolve(),
        sendPhase: () => true,
        sendCommand: (message) => {
          commands.push(message)
          return true
        },
      }
    },
    issuer: {
      async challenge({ admissionNonce }) {
        const issuedAt = Date.now()
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
          issued_at: issuedAt,
          expires_at: issuedAt + 8000,
        }
      },
      async capability() {
        const actions =
          input.grants[Math.min(admissions++, input.grants.length - 1)]!
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
            role,
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
            actions,
          },
          issuer.privateKey,
        )
      },
    },
  })
  cleanups.push(() => control.dispose())
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
    await waitFor(() => states.at(-1)?.kind === 'ready')
  }
  return {
    control,
    states,
    commands,
    transports,
    admit,
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

/** The state the Moonraker collector builds, U1 included. */
function moonrakerState() {
  return normalizeMoonrakerSnapshot(
    {
      eventtime: 1,
      status: {
        webhooks: { state: 'ready' },
        print_stats: { state: 'standby' },
        virtual_sdcard: { progress: 0 },
      },
    },
    { printerKey: 'snapmaker-u1', observedAt: Date.now() },
  ).printer
}

/** The state the native Kobra X collector publishes for a synthetic report. */
async function kobraXState(modelId: string) {
  const directory = mkdtempSync(join(tmpdir(), 'rv-kx-'))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const clientCertFile = join(directory, 'client.json')
  writeFileSync(
    clientCertFile,
    JSON.stringify({
      version: 1,
      format: 'pem',
      subject: 'CN=AnycubicSlicer',
      commonName: 'AnycubicSlicer',
      notBefore: 1,
      notAfter: Date.now() + 3_600_000,
      notBeforeIso: 'synthetic',
      notAfterIso: 'synthetic',
      fingerprintSha256: 'a'.repeat(64),
      certificatePem: 'synthetic',
      keyPem: 'synthetic',
    }),
    { mode: 0o600 },
  )
  const status = createKobraXStatus('synthetic', '127.0.0.1')
  status.report('info', {
    type: 'info',
    action: 'report',
    data: { state: 'free' },
    state: 'done',
    code: 200,
  })
  const observed: RawPrinterObservation[] = []
  const controller = new AbortController()
  const collection = createKobraXCollection({
    binding: {
      printerKey: 'synthetic',
      host: '127.0.0.1',
      modelId,
      deviceId: 'synthetic',
      clientCertFile,
      pinSha256: 'a'.repeat(64),
    },
    signal: controller.signal,
    pollMs: 5,
    connect: (async () => ({
      snapshot: status.snapshot,
      identity: { deviceId: 'synthetic', modelId, name: 'synthetic' },
      close: async () => {},
    })) as unknown as NonNullable<
      Parameters<typeof createKobraXCollection>[0]['connect']
    >,
    onObservation: (value) => observed.push(value),
    onUnavailable: () => {},
  })
  cleanups.push(async () => {
    controller.abort()
    await collection.done
  })
  await waitFor(() => observed.length > 0)
  expect(observed[0]!.printer.state).not.toBe('offline')
  return observed[0]!.printer
}

describe('#870 result wait from real collector state', () => {
  test.each([
    ['home', { axes: ['x', 'y', 'z'] }],
    ['gcode', { line: 'T2' }],
    ['gcode', { line: 'G28 X Y' }],
  ] as const)(
    'Moonraker state without identity keeps %s %o waiting past 5 s',
    async (action, args) => {
      const state = moonrakerState()
      expect(state.identity).toBeUndefined()
      const driverFamily = pauseResultDriverFamilyFromIdentity(state.identity)
      expect(driverFamily).toBe('unknown')
      const f = await fixture({
        grants: [[action]],
        role: 'admin',
        driverFamily,
      })
      await f.admit(0)
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const outcome = f.control.issueControlCommand(action, { ...args })
      await waitFor(() => f.commands.length === 1)
      vi.advanceTimersByTime(28_999)
      expect(f.states.at(-1)).toEqual({ kind: 'sending' })
      f.result(decodeCommandV2(f.commands[0]!.wire).cmd_id)
      expect(await outcome).toBe('applied')
      expect(f.commands).toHaveLength(1)
    },
  )

  test('an unknown family keeps the default wait for other actions', () => {
    expect(pauseCommandResultWaitMs('unknown', 'pause')).toBe(5_000)
    expect(
      pauseCommandResultWaitMs('unknown', 'gcode', { line: 'M117 oi' }),
    ).toBe(5_000)
    expect(pauseCommandResultWaitMs('moonraker', 'home')).toBe(5_000)
  })

  test('the Kobra X collector advertises its proven model, which gets the long wait', async () => {
    const state = await kobraXState('20030')
    const family = pauseResultDriverFamilyFromIdentity(state.identity)
    expect(family).toBe('kobra-x')
    for (const action of ['pause', 'start_print', 'set_temperature'] as const)
      expect(pauseCommandResultWaitMs(family, action)).toBe(29_000)
  })

  test('an unproven Kobra X model id stays unknown', async () => {
    expect((await kobraXState('99999')).identity).toBeUndefined()
  })
})
