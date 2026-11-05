import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { z } from '../../packages/farm-protocol/node_modules/zod/index.js'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import {
  BrowserDeviceProofChallenge,
  signBrowserDeviceProof,
  validateBrowserDevicePublicKey,
} from '../../packages/farm-protocol/src/browser-device-proof.ts'
import { BROWSER_DEVICE_HTTP_AUDIENCE } from '../../packages/farm-protocol/src/browser-device-http.ts'
import {
  ControlSessionBinding,
  controlBindingHash,
  encodeControlProof,
  signControlSessionProof,
} from '../../packages/farm-protocol/src/control-session-binding.ts'
import {
  PauseAdmissionChallenge,
  SignedPauseCapabilityV1,
  encodePauseAdmissionProof,
  encodePauseCapability,
  signPauseAdmissionProof,
  verifyPauseCapability,
} from '../../packages/farm-protocol/src/pause-capability.ts'
import { PairingProofAudience } from '../../packages/farm-protocol/src/pairing-proof.ts'
import { parseBoundedJson } from '../../packages/farm-protocol/src/json.ts'
import type {
  SignallingFixtureExtension,
  SignallingIdentityInput,
} from './signalling-https-fixture-contract.ts'
import type {
  PauseHttpsAuditRequest,
  PauseHttpsAuditReceipt,
} from './pause-authority-https-audit.ts'

export const PauseHttpsIssuer = z.strictObject({
  issuer: PairingProofAudience,
  kid: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  audience: PairingProofAudience,
  publicKeySpki: z.string().regex(/^[A-Za-z0-9_-]{59}$/),
})
function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
export function fixtureCredentialJti(token: string): string {
  ensure(token.length <= 16384, 'Fixture credential exceeded bound')
  const parts = token.split('.')
  ensure(
    parts.length === 3 && /^[A-Za-z0-9_-]+$/.test(parts[1] ?? ''),
    'Malformed fixture credential',
  )
  const payload = parseBoundedJson(
    new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.from(parts[1]!, 'base64url'),
    ),
    { maxBytes: 12288, maxDepth: 4, maxValues: 64, maxStringChars: 4096 },
  )
  return z.object({ jti: z.uuid() }).parse(payload).jti // Lookup only; real server verifies credential authority.
}
export function escapedFixtureObject(
  input: Readonly<Record<string, string>>,
): string {
  return (
    '{' +
    Object.entries(input)
      .map(
        ([key, value]) =>
          JSON.stringify(key) +
          ':"' +
          Array.from(value)
            .map((character) => {
              ensure(
                character.length === 1 && character.charCodeAt(0) <= 127,
                'Fixture wire must be canonical ASCII',
              )
              return (
                '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')
              )
            })
            .join('') +
          '"',
      )
      .join(',') +
    '}'
  )
}
/** Test-only native proof custody. These keys are really enrolled, but no RTC/browser custody is asserted. */
export function createPauseAuthorityHttpsFixtureExtension(
  input: Readonly<
    z.infer<typeof PauseHttpsIssuer> & {
      audit: (
        request: PauseHttpsAuditRequest,
      ) => Promise<PauseHttpsAuditReceipt>
    }
  >,
): SignallingFixtureExtension {
  const { audit } = input
  const issuer = PauseHttpsIssuer.parse({
    issuer: input.issuer,
    kid: input.kid,
    audience: input.audience,
    publicKeySpki: input.publicKeySpki,
  })
  let state:
    | {
        key: CryptoKey
        connector: ConnectorIdentity
        publicKey: Awaited<ReturnType<typeof validateBrowserDevicePublicKey>>
        trusted: SignallingIdentityInput
      }
    | undefined
  let started = false,
    disposed = false
  return {
    async identityHandles(trusted) {
      ensure(
        !started && !disposed && !trusted.signal.aborted,
        'Fixture identity unavailable',
      )
      started = true
      const pair = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign', 'verify'],
      )
      const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
      const publicKey = await validateBrowserDevicePublicKey({
        kty: jwk.kty,
        crv: jwk.crv,
        x: jwk.x,
        y: jwk.y,
      })
      ensure(!disposed && !trusted.signal.aborted, 'Fixture identity cancelled')
      const connector = new ConnectorIdentity(
        generateKeyPairSync('ed25519').privateKey,
      )
      state = {
        key: pair.privateKey,
        publicKey,
        connector,
        trusted: { ...trusted },
      }
      return {
        browser: {
          publicJwk: publicKey.publicKey,
          async signEnrollment(value) {
            const challenge = BrowserDeviceProofChallenge.parse(value),
              now = Date.now()
            ensure(
              state &&
                !disposed &&
                !trusted.signal.aborted &&
                challenge.purpose === 'enroll' &&
                challenge.account_id === trusted.accountId &&
                challenge.farm_id === trusted.farmId &&
                challenge.origin === trusted.origin &&
                challenge.audience === BROWSER_DEVICE_HTTP_AUDIENCE &&
                challenge.thumbprint === publicKey.thumbprint &&
                challenge.issued_at <= now &&
                now < challenge.expires_at,
              'Fixture enrollment scope mismatch',
            )
            return signBrowserDeviceProof(challenge, pair.privateKey)
          },
        },
        connector: {
          publicKeySpki: connector.publicKeySpki,
          fingerprint: connector.fingerprint,
          async signPairing(challenge, origin, audience) {
            ensure(
              !disposed &&
                !trusted.signal.aborted &&
                origin === trusted.origin &&
                audience === trusted.audience,
              'Fixture pairing scope mismatch',
            )
            return connector.signPairingProof({
              challenge,
              expectedOrigin: trusted.origin,
              expectedAudience: trusted.audience,
              now: Date.now(),
            })
          },
        },
        async dispose() {
          disposed = true
          state = undefined
        },
      }
    },
    async afterProvisioned(fixture) {
      const identity = state
      ensure(
        identity &&
          !disposed &&
          fixture.accountId === identity.trusted.accountId &&
          fixture.farmId === identity.trusted.farmId &&
          fixture.origin === identity.trusted.origin &&
          fixture.assignmentRefs.length === 1 &&
          fixture.browserThumbprint === identity.publicKey.thumbprint,
        'Fixture provisioned scope mismatch',
      )
      const assignment = fixture.assignmentRefs[0]!
      ensure(
        assignment.agentId === fixture.claim.agent_id,
        'Fixture assignment mismatch',
      )
      const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), 45000)
      const signal = AbortSignal.any([fixture.signal, controller.signal])
      try {
        const ca = await readFile(fixture.caPath)
        const cookies = await fixture.ownerContext.cookies(fixture.origin)
        const session = cookies.filter(
          (value) => value.name === '__Host-open3dfarmmanager-session',
        )
        ensure(
          session.length === 1 &&
            session[0]!.secure &&
            session[0]!.httpOnly &&
            session[0]!.path === '/',
          'Fixture session cookie missing',
        )
        const cookie = `${session[0]!.name}=${session[0]!.value}`
        const post = async (
          path: string,
          body: string,
          expected: number,
          options: Readonly<{ anonymous?: boolean; origin?: string }> = {},
        ) => {
          ensure(!signal.aborted, 'Fixture expired')
          const result = await new Promise<{ status: number; body: string }>(
            (resolve, reject) => {
              let responseValue: { status: number; body: string } | undefined
              let failed = false
              const req = httpsRequest(
                new URL(path, fixture.origin),
                {
                  method: 'POST',
                  ca,
                  rejectUnauthorized: true,
                  agent: false,
                  signal,
                  headers: {
                    origin: options.origin ?? fixture.origin,
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(body),
                    ...(!options.anonymous ? { cookie } : {}),
                  },
                },
                (response) => {
                  const chunks: Buffer[] = []
                  let size = 0
                  response.on('data', (chunk: Buffer) => {
                    size += chunk.length
                    if (size > 131072) {
                      req.destroy(new Error('Fixture response exceeded bound'))
                      return
                    }
                    chunks.push(chunk)
                  })
                  response.once('error', () => {
                    failed = true
                    req.destroy()
                  })
                  response.once('aborted', () => {
                    failed = true
                    req.destroy()
                  })
                  response.once('end', () => {
                    responseValue = {
                      status: response.statusCode ?? 0,
                      body: Buffer.concat(chunks).toString('utf8'),
                    }
                  })
                },
              )
              const timeout = setTimeout(
                () => req.destroy(new Error('Fixture request timed out')),
                5000,
              )
              req.once('close', () => {
                clearTimeout(timeout)
                if (failed || !responseValue)
                  reject(new Error('Fixture HTTPS request failed'))
                else resolve(responseValue)
              })
              req.once('error', () => {
                failed = true
              })
              req.end(body)
            },
          )
          ensure(
            result.status === expected,
            `Unexpected HTTP status at ${path}; expected ${expected}`,
          )
          return result.body
        }
        const challengePath = '/api/pause-authority/challenges',
          capabilityPath = '/api/pause-authority/capabilities'
        const initial = await audit({ stage: 'initial' })
        ensure(
          initial.rows === 0 && initial.issued === 0 && initial.attempts === 0,
          'Fixture pause state is not empty',
        )
        await post(challengePath, '{}', 401, { anonymous: true })
        await post(challengePath, '{}', 403, {
          origin: 'https://wrong-origin.example',
        })
        await post(challengePath, '{', 400)
        await post(challengePath, JSON.stringify({ unexpected: true }), 400)
        await post(challengePath, ' '.repeat(102401), 413)
        await post(capabilityPath, ' '.repeat(51201), 413)
        await post(
          capabilityPath,
          JSON.stringify({ admissionProofWire: 'é'.repeat(25601) }),
          413,
        )
        await post(
          challengePath,
          JSON.stringify({
            browserProofWire: '{}',
            connectorProofWire: '{}',
            admissionNonce: randomBytes(32).toString('base64url'),
          }),
          400,
        )
        const denied = await audit({ stage: 'negatives' })
        ensure(
          denied.rows === 0 && denied.issued === 0 && denied.attempts === 0,
          'Denied requests allocated issuer state',
        )
        const jti = fixtureCredentialJti(fixture.claim.device_token)
        const issue = async () => {
          const now = Date.now()
          const binding = ControlSessionBinding.parse({
            v: 1,
            purpose: 'pause-rtc',
            transport_id: randomUUID(),
            farm_id: fixture.farmId,
            agent_id: fixture.claim.agent_id,
            account_id: fixture.accountId,
            key_id: fixture.browserKeyId,
            assignment_id: assignment.assignmentId,
            browser_public_key: identity.publicKey.publicKey,
            browser_thumbprint: identity.publicKey.thumbprint,
            connector_public_key_spki: identity.connector.publicKeySpki,
            connector_fingerprint: identity.connector.fingerprint,
            credential_jti: jti,
            origin: fixture.origin,
            audience: issuer.audience,
            browser_nonce: randomBytes(32).toString('base64url'),
            connector_nonce: randomBytes(32).toString('base64url'),
            issued_at: now,
            expires_at: now + 30000,
            offer_sha256: randomBytes(32).toString('base64url'),
            answer_sha256: randomBytes(32).toString('base64url'),
            browser_dtls: randomBytes(32)
              .toString('hex')
              .toUpperCase()
              .match(/../g)!
              .join(':'),
            connector_dtls: randomBytes(32)
              .toString('hex')
              .toUpperCase()
              .match(/../g)!
              .join(':'),
          })
          const browserProofWire = encodeControlProof({
            v: 1,
            role: 'browser',
            binding,
            signature: await signControlSessionProof(
              binding,
              'browser',
              identity.key,
            ),
          })
          const connectorProofWire = encodeControlProof(
            await identity.connector.signControlSessionProof({
              binding,
              expectedAgentId: fixture.claim.agent_id,
            }),
          )
          const admissionNonce = randomBytes(32).toString('base64url'),
            body = escapedFixtureObject({
              browserProofWire,
              connectorProofWire,
              admissionNonce,
            })
          ensure(
            Buffer.byteLength(body) <= 102400,
            'Fixture escaped proof exceeded outer cap',
          )
          const challenge = z
            .strictObject({ challenge: PauseAdmissionChallenge })
            .parse(JSON.parse(await post(challengePath, body, 200))).challenge
          const hash = await controlBindingHash(binding)
          ensure(
            challenge.control_binding_sha256 === hash &&
              challenge.admission_nonce === admissionNonce &&
              challenge.account_id === fixture.accountId &&
              challenge.farm_id === fixture.farmId &&
              challenge.agent_id === fixture.claim.agent_id &&
              challenge.key_id === fixture.browserKeyId &&
              challenge.assignment_id === assignment.assignmentId &&
              challenge.transport_id === binding.transport_id &&
              challenge.origin === fixture.origin &&
              challenge.audience === issuer.audience &&
              challenge.browser_thumbprint === identity.publicKey.thumbprint &&
              challenge.issued_at >= now &&
              challenge.expires_at <= binding.expires_at &&
              Date.now() < challenge.expires_at,
            'Fixture admission challenge mismatch',
          )
          const admissionProofWire = encodePauseAdmissionProof(
            await signPauseAdmissionProof(challenge, identity.key),
          )
          const proof = escapedFixtureObject({ admissionProofWire })
          ensure(
            Buffer.byteLength(proof) <= 51200,
            'Fixture escaped admission exceeded outer cap',
          )
          return { binding, challenge, body, proof, hash, admissionNonce }
        }
        const first = await issue()
        const selector = {
          challengeId: first.challenge.challenge_id,
          transportId: first.binding.transport_id,
        }
        const pending = await audit({ stage: 'pending', ...selector })
        ensure(
          pending.rows === 1 &&
            pending.issued === 0 &&
            pending.attempts === 1 &&
            pending.row?.status === 'pending' &&
            pending.row.scopeMatches,
          'Pending challenge audit failed',
        )
        const capability = z
          .strictObject({ capability: SignedPauseCapabilityV1 })
          .parse(
            JSON.parse(await post(capabilityPath, first.proof, 200)),
          ).capability
        const publicKey = await crypto.subtle.importKey(
          'spki',
          new Uint8Array(Buffer.from(issuer.publicKeySpki, 'base64url')),
          { name: 'Ed25519' },
          false,
          ['verify'],
        )
        ensure(
          await verifyPauseCapability(capability, publicKey),
          'Issuer signature mismatch',
        )
        ensure(
          capability.issuer === issuer.issuer &&
            capability.kid === issuer.kid &&
            capability.audience === issuer.audience &&
            capability.origin === fixture.origin &&
            capability.account_id === fixture.accountId &&
            capability.role === 'owner' &&
            capability.farm_id === fixture.farmId &&
            capability.agent_id === fixture.claim.agent_id &&
            capability.key_id === fixture.browserKeyId &&
            capability.assignment_id === assignment.assignmentId &&
            capability.transport_id === first.binding.transport_id &&
            capability.credential_jti === jti &&
            capability.printer_key === assignment.printerKey &&
            capability.browser_thumbprint === identity.publicKey.thumbprint &&
            capability.connector_fingerprint ===
              identity.connector.fingerprint &&
            capability.control_binding_sha256 === first.hash &&
            capability.admission_nonce === first.admissionNonce &&
            capability.expires_at <= first.binding.expires_at &&
            Date.now() < capability.expires_at,
          'Issued capability scope mismatch',
        )
        const capabilityHash = createHash('sha256')
          .update(encodePauseCapability(capability))
          .digest('base64url')
        const issued = await audit({
          stage: 'issued',
          ...selector,
          capabilityHash,
        })
        ensure(
          issued.rows === 1 &&
            issued.issued === 1 &&
            issued.row?.status === 'issued' &&
            issued.row.capabilityId === capability.capability_id &&
            issued.row.expectedHashMatches &&
            issued.row.scopeMatches,
          'Issued capability audit failed',
        )
        await post(challengePath, first.body, 403)
        await post(capabilityPath, first.proof, 403)
        const replay = await audit({
          stage: 'replay',
          ...selector,
          capabilityHash,
        })
        ensure(
          replay.rows === 1 &&
            replay.issued === 1 &&
            replay.attempts === 1 &&
            replay.row?.expectedHashMatches &&
            replay.row.capabilityId === capability.capability_id,
          'Replay mutated issuance',
        )
        const second = await issue()
        const logoutStatus = await fixture.ownerPage.evaluate(async () => {
          const response = await fetch('/api/auth/logout', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
          return response.status
        })
        ensure(logoutStatus === 200, 'Fixture logout failed')
        await post(capabilityPath, second.proof, 401)
        const revoked = await audit({
          stage: 'revoked',
          challengeId: second.challenge.challenge_id,
          transportId: second.binding.transport_id,
        })
        ensure(
          revoked.rows === 2 &&
            revoked.issued === 1 &&
            revoked.attempts === 2 &&
            revoked.row?.revokedSession &&
            revoked.row.capabilityId === null,
          'Revoked session issued a capability',
        )
        ensure(!signal.aborted, 'Fixture completion exceeded deadline')
      } finally {
        clearTimeout(timer)
        controller.abort()
      }
    },
  }
}
