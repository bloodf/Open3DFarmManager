import { z } from '../../packages/farm-protocol/node_modules/zod/index.js'
import {
  BrowserDeviceProofChallenge,
  signBrowserDeviceProof,
  validateBrowserDevicePublicKey,
} from '../../packages/farm-protocol/src/browser-device-proof.ts'
import { BROWSER_DEVICE_HTTP_AUDIENCE } from '../../packages/farm-protocol/src/browser-device-http.ts'
import { controlBindingHash } from '../../packages/farm-protocol/src/control-session-binding.ts'
import {
  PauseAdmissionChallenge,
  SignedPauseCapabilityV1,
  signPauseAdmissionProof,
  encodePauseAdmissionProof,
  encodePauseCapability,
  verifyPauseCapability,
} from '../../packages/farm-protocol/src/pause-capability.ts'
import { PauseChannelFrame } from '../../packages/farm-protocol/src/pause-channel.ts'
import { parseBoundedJson } from '../../packages/farm-protocol/src/json.ts'
import { canonicalize } from '../../packages/farm-protocol/src/canonical.ts'
import { PauseBrowserSignallingClient } from '../../apps/farm/app/utils/webrtc/pause-signalling-client.ts'
import type {
  PauseProofsReady,
  PausePhaseFrame,
} from '../../packages/connector/src/webrtc/pause-control-session.ts'

export type PauseBrowserFixtureInput = Readonly<{
  accountId: string
  farmId: string
  origin: string
  audience: string
  issuer: string
  kid: string
  publicKeySpki: string
}>
/** Original fixture actor: page-local key and actual client; no manufactured transcript or proof. */
export async function createPauseRtcBrowserActor(
  input: PauseBrowserFixtureInput,
) {
  const scope = Object.freeze({ ...input })
  if (location.origin !== scope.origin || location.protocol !== 'https:')
    throw Error('Pause fixture origin mismatch')
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const identity = await validateBrowserDevicePublicKey({
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
  })
  const issuerBytes = Uint8Array.from(
    atob(scope.publicKeySpki.replace(/-/g, '+').replace(/_/g, '/')),
    (character) => character.charCodeAt(0),
  )
  const issuerKey = await crypto.subtle.importKey(
    'spki',
    issuerBytes,
    'Ed25519',
    false,
    ['verify'],
  )
  let enrolled = false,
    terminal = false,
    failed = false,
    issued = false,
    working: Promise<void> | undefined
  let client: PauseBrowserSignallingClient | undefined,
    proofs: PauseProofsReady | undefined
  let nonce:
    | Extract<PausePhaseFrame, { t: 'control.admission-nonce' }>
    | undefined
  let receipt:
    | Readonly<{
        transportId: string
        challengeId: string
        capabilityHash: string
      }>
    | undefined
  const abort = new AbortController()
  const stop = () => {
    terminal = true
    abort.abort()
    client?.close('fixture-closed')
  }
  function active() {
    if (
      terminal ||
      abort.signal.aborted ||
      !proofs ||
      performance.now() >= proofs.deadlineMonoMs ||
      Date.now() >= proofs.binding.expires_at
    )
      throw Error('Pause fixture authority expired')
  }
  async function post(path: string, body: unknown, deadline: number) {
    active()
    const controller = new AbortController()
    const ms = Math.min(
      2000,
      deadline - Date.now(),
      proofs!.deadlineMonoMs - performance.now(),
    )
    if (ms <= 0) throw Error('Pause fixture HTTP expired')
    const timer = setTimeout(() => controller.abort(), ms)
    try {
      const response = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.any([abort.signal, controller.signal]),
      })
      if (response.status !== 200 || !response.body)
        throw Error('Pause fixture HTTP rejected')
      const reader = response.body.getReader()
      let text = '',
        bytes = 0
      const decoder = new TextDecoder('utf-8', { fatal: true })
      try {
        while (true) {
          const next = await reader.read()
          if (next.done) break
          bytes += next.value.byteLength
          if (bytes > 16384) throw Error('Pause fixture HTTP response bound')
          text += decoder.decode(next.value, { stream: true })
        }
        text += decoder.decode()
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
      active()
      if (Date.now() >= deadline) throw Error('Pause fixture HTTP expired')
      return parseBoundedJson(text, {
        maxBytes: 16384,
        maxDepth: 6,
        maxValues: 128,
        maxStringChars: 8192,
      })
    } finally {
      clearTimeout(timer)
    }
  }
  async function issue() {
    active()
    const ready = proofs!,
      fresh = nonce!
    const binding = ready.binding
    if (
      fresh.transport_id !== binding.transport_id ||
      Date.now() < fresh.issued_at ||
      Date.now() >= fresh.expires_at ||
      fresh.expires_at > binding.expires_at
    )
      throw Error('Pause nonce mismatch')
    const hash = await controlBindingHash(binding)
    active()
    const challenge = z
      .strictObject({ challenge: PauseAdmissionChallenge })
      .parse(
        await post(
          '/api/pause-authority/challenges',
          {
            browserProofWire: ready.browserProofWire,
            connectorProofWire: ready.connectorProofWire,
            admissionNonce: fresh.admission_nonce,
          },
          fresh.expires_at,
        ),
      ).challenge
    if (
      challenge.transport_id !== binding.transport_id ||
      challenge.farm_id !== binding.farm_id ||
      challenge.agent_id !== binding.agent_id ||
      challenge.account_id !== binding.account_id ||
      challenge.key_id !== binding.key_id ||
      challenge.assignment_id !== binding.assignment_id ||
      challenge.origin !== scope.origin ||
      challenge.audience !== scope.audience ||
      challenge.browser_thumbprint !== identity.thumbprint ||
      challenge.control_binding_sha256 !== hash ||
      challenge.admission_nonce !== fresh.admission_nonce ||
      Date.now() < challenge.issued_at ||
      Date.now() >= challenge.expires_at
    )
      throw Error('Pause issuer challenge mismatch')
    const admissionProofWire = encodePauseAdmissionProof(
      await signPauseAdmissionProof(challenge, pair.privateKey),
    )
    active()
    const capability = z
      .strictObject({ capability: SignedPauseCapabilityV1 })
      .parse(
        await post(
          '/api/pause-authority/capabilities',
          { admissionProofWire },
          Math.min(challenge.expires_at, fresh.expires_at),
        ),
      ).capability
    if (!(await verifyPauseCapability(capability, issuerKey)))
      throw Error('Pause issuer signature mismatch')
    active()
    if (
      capability.issuer !== scope.issuer ||
      capability.kid !== scope.kid ||
      capability.control_binding_sha256 !== hash ||
      capability.transport_id !== binding.transport_id ||
      capability.assignment_id !== binding.assignment_id ||
      capability.account_id !== scope.accountId ||
      capability.farm_id !== scope.farmId ||
      capability.agent_id !== binding.agent_id ||
      capability.key_id !== binding.key_id ||
      capability.origin !== scope.origin ||
      capability.audience !== scope.audience ||
      capability.admission_nonce !== fresh.admission_nonce ||
      capability.credential_jti !== binding.credential_jti ||
      capability.connector_fingerprint !== binding.connector_fingerprint ||
      canonicalize(capability.browser_public_key) !==
        canonicalize(identity.publicKey) ||
      capability.expires_at > binding.expires_at ||
      Date.now() >= capability.expires_at
    )
      throw Error('Pause issuer capability mismatch')
    const wire = encodePauseCapability(capability)
    if (
      !client?.sendPhase({
        t: 'control.admission-proof',
        wire: admissionProofWire,
      }) ||
      !client.sendPhase({ t: 'control.capability', wire })
    )
      throw Error('Pause capability delivery failed')
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(wire),
    )
    active()
    receipt = Object.freeze({
      transportId: binding.transport_id,
      challengeId: challenge.challenge_id,
      capabilityHash: Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join(''),
    })
    issued = true
  }
  function maybeIssue() {
    if (working || !proofs || !nonce || terminal) return
    working = issue().catch(() => {
      failed = true
      stop()
    })
  }
  return Object.freeze({
    publicJwk: Object.freeze({ ...identity.publicKey }),
    async signEnrollment(value: unknown) {
      const c = BrowserDeviceProofChallenge.parse(value),
        now = Date.now()
      if (
        terminal ||
        enrolled ||
        c.purpose !== 'enroll' ||
        c.account_id !== scope.accountId ||
        c.farm_id !== scope.farmId ||
        c.origin !== scope.origin ||
        c.audience !== BROWSER_DEVICE_HTTP_AUDIENCE ||
        c.thumbprint !== identity.thumbprint ||
        now < c.issued_at ||
        now >= c.expires_at
      )
        throw Error('Pause fixture enrollment mismatch')
      enrolled = true
      const signature = await signBrowserDeviceProof(c, pair.privateKey)
      if (terminal || Date.now() >= c.expires_at)
        throw Error('Pause fixture enrollment expired')
      return signature
    },
    start(value: {
      browserKeyId: string
      agentId: string
      assignmentId: string
    }) {
      if (client || terminal || !enrolled)
        throw Error('Pause fixture start unavailable')
      client = new PauseBrowserSignallingClient(
        {
          accountId: scope.accountId,
          farmId: scope.farmId,
          origin: scope.origin,
          audience: scope.audience,
          keyId: value.browserKeyId,
          agentId: value.agentId,
          assignmentId: value.assignmentId,
          publicKey: identity.publicKey,
          privateKey: pair.privateKey,
        },
        {
          signal: abort.signal,
          onProofsReady: (ready) => {
            if (proofs) throw Error('Repeated proofs')
            proofs = ready
            maybeIssue()
          },
          onPhase: (frame) => {
            const parsed = PauseChannelFrame.parse(frame)
            if (parsed.t !== 'control.admission-nonce' || nonce)
              throw Error('Unexpected fixture phase')
            nonce = parsed
            maybeIssue()
          },
          onTerminal: () => {
            terminal = true
            abort.abort()
          },
        },
      )
      void client.start().catch(() => {
        failed = true
        stop()
      })
    },
    observe() {
      return {
        terminal,
        failed,
        proofsReady: !!proofs,
        issued,
        receipt,
        diagnostics: client?.diagnostics(),
      }
    },
    async dispose() {
      stop()
      const results = await Promise.allSettled([working, client?.dispose(3000)])
      if (results.some((result) => result.status === 'rejected'))
        throw Error('Pause browser cleanup incomplete')
    },
  })
}
