import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openConfigurationBrowserSession } from '../../apps/farm/app/utils/kobralink-onboarding.ts'
import {
  ConfigurationBrowserSignallingClient,
  type ConfigurationBrowserSocketPort,
} from '../../apps/farm/app/utils/webrtc/configuration-signalling-client.ts'
import type {
  ConfigurationBrowserPeerOptions,
  ConfigurationProofsReady,
} from '../../apps/farm/app/utils/webrtc/configuration-browser-peer.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import {
  decodeConfigurationAdmissionProof,
  signConfigurationCapability,
} from '../../packages/farm-protocol/src/configuration-capability.ts'
import { CONFIGURATION_PROTOCOL } from '../../packages/farm-protocol/src/configuration-common.ts'
import { encodeConfigurationSignallingServerFrame } from '../../packages/farm-protocol/src/configuration-signalling.ts'
import { base64url } from '../../packages/farm-protocol/src/encoding.ts'

// Drives the exported production session flow with the real signalling client.
// Only the WebSocket, the RTC peer and the same-origin HTTP authority are
// replaced, each at its documented injection boundary.

const ORIGIN = 'https://farm.example.test'
const AUDIENCE = 'open3dfarm-test'
const ISSUER_KID = 'test-issuer'
const ACCOUNT_ID = 'account-a'
const digest = () => base64url(crypto.getRandomValues(new Uint8Array(32)))

type Input = Parameters<typeof openConfigurationBrowserSession>[0]
type SocketHandlers = Parameters<ConfigurationBrowserSocketPort['bind']>[0]

function fakeSocket() {
  let handlers: SocketHandlers | undefined
  let open = false
  let resolveClosed!: () => void
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  const state = { sent: [] as string[], closeCalls: 0, bound: false }
  const port: ConfigurationBrowserSocketPort = {
    isOpen: () => open,
    bufferedBytes: () => 0,
    send: (wire) => {
      state.sent.push(wire)
    },
    bind: (value) => {
      handlers = value
      state.bound = true
      return () => {
        handlers = undefined
        state.bound = false
      }
    },
    close: () => {
      state.closeCalls++
      open = false
      resolveClosed()
    },
    waitClosed: () => closed,
  }
  return {
    port,
    state,
    isBound: () => handlers !== undefined,
    open() {
      open = true
      handlers?.open()
    },
    deliver(frame: unknown) {
      handlers?.message(encodeConfigurationSignallingServerFrame(frame))
    },
    /** The remote end drops the socket, as a refusing server does. */
    drop() {
      open = false
      handlers?.close()
    },
  }
}

async function fixture(
  options: {
    socketFactory?: () => Promise<ConfigurationBrowserSocketPort>
    requestTimeoutMs?: number
  } = {},
) {
  const farmId = crypto.randomUUID()
  const agentId = crypto.randomUUID()
  const keyId = crypto.randomUUID()
  const transportId = crypto.randomUUID()
  const credentialJti = crypto.randomUUID()
  const bindingHash = digest()
  const connectorFingerprint = 'SHA256:' + digest()
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
  const { publicKey, thumbprint } = await validateBrowserDevicePublicKey({
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
  })
  const issuerKeys = (await crypto.subtle.generateKey(
    { name: 'Ed25519' },
    false,
    ['sign', 'verify'],
  )) as CryptoKeyPair

  const socket = fakeSocket()
  const peer = {
    options: undefined as ConfigurationBrowserPeerOptions | undefined,
    sendResult: true,
    sent: [] as unknown[],
    closeReasons: [] as string[],
  }
  const controller = new AbortController()
  const clients: ConfigurationBrowserSignallingClient[] = []

  const input: Input = {
    accountId: ACCOUNT_ID,
    farmId,
    agentId,
    keyId,
    localKey: { thumbprint, publicKey, keyPair },
    bootstrap: {
      bootstrap: { connectorFingerprint, origin: ORIGIN, audience: AUDIENCE },
      issuer: { issuerKid: ISSUER_KID, origin: ORIGIN, audience: AUDIENCE },
      issuerPublicKey: issuerKeys.publicKey,
    } as unknown as Input['bootstrap'],
    signal: controller.signal,
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
    createSignalling(scope, signallingOptions) {
      const client = new ConfigurationBrowserSignallingClient(scope, {
        ...signallingOptions,
        peerFactory(peerOptions) {
          peer.options = peerOptions
          return {
            answer: async () => 'unused',
            closed: Promise.resolve(),
            close(reason?: string) {
              peer.closeReasons.push(reason ?? 'closed')
            },
            sendMessage(message) {
              peer.sent.push(message)
              return peer.sendResult
            },
          }
        },
      })
      clients.push(client)
      return {
        start: () =>
          client.start(options.socketFactory ?? (async () => socket.port)),
        sendMessage: (message) => client.sendMessage(message),
        close: (reason) => client.close(reason),
        dispose: (timeoutMs) => client.dispose(timeoutMs),
      }
    },
  }

  /** Advances signalling to the RTC offer phase; returns the proof delivery. */
  async function reachOffer() {
    await vi.waitFor(() => expect(socket.isBound()).toBe(true))
    socket.open()
    const now = Date.now()
    socket.deliver({
      v: 1,
      t: 'config.ready',
      transport_id: transportId,
      farm_id: farmId,
      agent_id: agentId,
      key_id: keyId,
      revision: 3,
      browser_nonce: digest(),
      issued_at: now,
      expires_at: now + 10_000,
    })
    await vi.waitFor(() => expect(peer.options).toBeDefined())
    const proofs = {
      binding: { transport_id: transportId, credential_jti: credentialJti },
      bindingHash,
      browserProofWire: 'browser-proof',
      connectorProofWire: 'connector-proof',
      connectorPublicKey: issuerKeys.publicKey,
      expiresAt: now + 10_000,
      deadlineMonoMs: performance.now() + 10_000,
    } as unknown as ConfigurationProofsReady
    return () => peer.options!.onProofsReady?.(proofs)
  }

  /** Completes signalling up to authenticated proofs, as a real Connector would. */
  async function admit() {
    const deliverProofs = await reachOffer()
    deliverProofs()
  }

  /** Same-origin authority double: issues a correctly signed capability. */
  const authority = vi.fn(async (path: string, init: { body: string }) => {
    const body = JSON.parse(init.body)
    const now = Date.now()
    if (path === '/api/configuration-authority/challenges') {
      return Response.json({
        challenge: {
          v: 1,
          purpose: 'configuration-admission',
          protocol: CONFIGURATION_PROTOCOL,
          challenge_id: crypto.randomUUID(),
          capability_id: crypto.randomUUID(),
          farm_id: farmId,
          agent_id: agentId,
          key_id: keyId,
          transport_id: transportId,
          account_id: ACCOUNT_ID,
          browser_thumbprint: thumbprint,
          origin: ORIGIN,
          audience: AUDIENCE,
          configuration_binding_sha256: bindingHash,
          admission_nonce: body.admissionNonce,
          action: body.action,
          operation_id: body.operationId,
          expected_revision: body.expectedRevision,
          target_sha256: body.targetSha256,
          issued_at: now,
          expires_at: now + 5000,
        },
      })
    }
    if (path === '/api/configuration-authority/capabilities') {
      const { challenge } = decodeConfigurationAdmissionProof(
        body.admissionProofWire,
      )
      const capability = await signConfigurationCapability(
        {
          v: 1,
          purpose: 'configuration-authority',
          protocol: CONFIGURATION_PROTOCOL,
          capability_id: challenge.capability_id,
          kid: ISSUER_KID,
          issuer: AUDIENCE,
          audience: AUDIENCE,
          origin: ORIGIN,
          issued_at: now,
          expires_at: now + 5000,
          account_id: ACCOUNT_ID,
          role: 'owner',
          farm_id: farmId,
          agent_id: agentId,
          key_id: keyId,
          transport_id: transportId,
          browser_public_key: publicKey,
          browser_thumbprint: thumbprint,
          connector_fingerprint: connectorFingerprint,
          credential_jti: credentialJti,
          configuration_binding_sha256: bindingHash,
          admission_nonce: challenge.admission_nonce,
          action: challenge.action,
          operation_id: challenge.operation_id,
          expected_revision: challenge.expected_revision,
          target_sha256: challenge.target_sha256,
        },
        issuerKeys.privateKey,
      )
      return Response.json({ capability })
    }
    throw new Error('Unexpected authority path ' + path)
  })
  vi.stubGlobal('fetch', authority)

  const cancelParams = () => ({
    operationId: crypto.randomUUID(),
    target: {} as never,
    targetSha256: digest(),
    expectedRevision: 3,
    signal: controller.signal,
  })

  return {
    input,
    socket,
    peer,
    controller,
    authority,
    admit,
    reachOffer,
    cancelParams,
  }
}

describe('configuration session refusal', () => {
  const unhandled: unknown[] = []
  const record = (reason: unknown) => {
    unhandled.push(reason)
  }
  /** Lets Node report any rejection that nobody observed. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

  beforeEach(() => {
    unhandled.length = 0
    process.on('unhandledRejection', record)
  })
  afterEach(async () => {
    await settle()
    process.off('unhandledRejection', record)
    vi.unstubAllGlobals()
    expect(unhandled).toEqual([])
  })

  it('refuses when the socket closes before start resolves', async () => {
    const { input, socket, peer, authority } = await fixture()
    const opening = openConfigurationBrowserSession(input)
    await vi.waitFor(() => expect(socket.isBound()).toBe(true))
    socket.open()
    socket.drop()
    await expect(opening).rejects.toThrow('socket-closed')
    await settle()
    expect(unhandled).toEqual([])
    expect(socket.state.sent).toHaveLength(1)
    expect(JSON.parse(socket.state.sent[0]!).t).toBe('config.begin')
    expect(socket.state.bound).toBe(false)
    expect(socket.state.closeCalls).toBe(1)
    expect(peer.sent).toEqual([])
    expect(authority).not.toHaveBeenCalled()
  })

  it('stays refused when proofs arrive after the socket closed', async () => {
    const { input, socket, peer, reachOffer } = await fixture()
    const opening = openConfigurationBrowserSession(input)
    const deliverProofs = await reachOffer()
    socket.drop()
    await expect(opening).rejects.toThrow('socket-closed')
    // Late proofs must not revive a refused session.
    deliverProofs()
    await settle()
    expect(unhandled).toEqual([])
    expect(peer.closeReasons).toEqual(['socket-closed'])
    expect(peer.sent).toEqual([])
    expect(socket.state.bound).toBe(false)
  })

  it('refuses when start itself fails', async () => {
    const { input, peer, authority } = await fixture({
      socketFactory: async () => {
        throw new Error('refused by server')
      },
    })
    await expect(openConfigurationBrowserSession(input)).rejects.toThrow(
      'connect-failed',
    )
    await settle()
    expect(unhandled).toEqual([])
    expect(peer.sent).toEqual([])
    expect(authority).not.toHaveBeenCalled()
  })

  it('refuses a signal aborted before start', async () => {
    const { input, socket, controller } = await fixture()
    controller.abort()
    await expect(openConfigurationBrowserSession(input)).rejects.toThrow(
      'aborted',
    )
    await settle()
    expect(unhandled).toEqual([])
    expect(socket.state.bound).toBe(false)
    expect(socket.state.sent).toEqual([])
  })

  it('refuses a signal aborted while opening', async () => {
    const { input, socket, controller, peer } = await fixture()
    const opening = openConfigurationBrowserSession(input)
    await vi.waitFor(() => expect(socket.isBound()).toBe(true))
    socket.open()
    controller.abort()
    await expect(opening).rejects.toThrow('aborted')
    await settle()
    expect(unhandled).toEqual([])
    expect(socket.state.bound).toBe(false)
    expect(socket.state.closeCalls).toBe(1)
    expect(peer.sent).toEqual([])
  })

  it('admits a session and exchanges nothing until asked', async () => {
    const { input, socket, peer, admit, authority } = await fixture()
    const opening = openConfigurationBrowserSession(input)
    await admit()
    const session = await opening
    expect(session.advertisedRevision).toBe(3)
    expect(session.isAlive()).toBe(true)
    expect(peer.sent).toEqual([])
    expect(authority).not.toHaveBeenCalled()
    session.close()
    expect(session.isAlive()).toBe(false)
    expect(socket.state.bound).toBe(false)
    expect(peer.closeReasons).toEqual(['closed'])
  })

  it('refuses requests after the socket closes on an admitted session', async () => {
    const { input, socket, peer, admit, authority, cancelParams } =
      await fixture()
    const opening = openConfigurationBrowserSession(input)
    await admit()
    const session = await opening
    socket.drop()
    expect(session.isAlive()).toBe(false)
    await expect(session.cancel(cancelParams())).rejects.toThrow(
      'socket-closed',
    )
    await settle()
    expect(unhandled).toEqual([])
    expect(peer.sent).toEqual([])
    expect(authority).not.toHaveBeenCalled()
    expect(peer.closeReasons).toEqual(['socket-closed'])
  })

  it('refuses the caller when the socket closes while a reply is pending', async () => {
    const { input, socket, peer, admit, cancelParams } = await fixture()
    const opening = openConfigurationBrowserSession(input)
    await admit()
    const session = await opening
    const pending = session.cancel(cancelParams())
    await vi.waitFor(() => expect(peer.sent).toHaveLength(1))
    socket.drop()
    await expect(pending).rejects.toThrow('socket-closed')
    await settle()
    expect(unhandled).toEqual([])
    await expect(session.cancel(cancelParams())).rejects.toThrow(
      'socket-closed',
    )
    expect(peer.sent).toHaveLength(1)
  })

  it('settles the reply waiter when the peer refuses the send', async () => {
    const { input, socket, peer, admit, cancelParams } = await fixture({
      requestTimeoutMs: 40,
    })
    const opening = openConfigurationBrowserSession(input)
    await admit()
    const session = await opening
    peer.sendResult = false
    await expect(session.cancel(cancelParams())).rejects.toThrow('send-failed')
    // Past the reply deadline: an abandoned waiter would reject here unobserved.
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(unhandled).toEqual([])
    // The refused send released the single reply slot.
    await expect(session.cancel(cancelParams())).rejects.toThrow('send-failed')
    expect(peer.sent).toHaveLength(2)
    socket.drop()
    await settle()
    expect(unhandled).toEqual([])
    await expect(session.cancel(cancelParams())).rejects.toThrow(
      'socket-closed',
    )
    expect(peer.sent).toHaveLength(2)
  })

  it('refuses the caller on abort while a reply is pending', async () => {
    const { input, socket, peer, admit, controller, cancelParams } =
      await fixture()
    const opening = openConfigurationBrowserSession(input)
    await admit()
    const session = await opening
    const pending = session.cancel(cancelParams())
    await vi.waitFor(() => expect(peer.sent).toHaveLength(1))
    controller.abort()
    await expect(pending).rejects.toThrow('aborted')
    await settle()
    expect(unhandled).toEqual([])
    expect(session.isAlive()).toBe(false)
    expect(socket.state.bound).toBe(false)
    expect(peer.closeReasons).toEqual(['aborted'])
  })
})
