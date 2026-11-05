import type { SignallingIdentityInput } from './signalling-https-fixture-contract.ts'
import {
  BrowserDeviceProofChallenge,
  BrowserDeviceTextId,
  BrowserDeviceUuid,
  signBrowserDeviceProof,
  validateBrowserDevicePublicKey,
} from '../../packages/farm-protocol/src/browser-device-proof.ts'
import { BROWSER_DEVICE_HTTP_AUDIENCE } from '../../packages/farm-protocol/src/browser-device-http.ts'
import {
  PairingProofAudience,
  PairingProofOrigin,
} from '../../packages/farm-protocol/src/pairing-proof.ts'
import { StatusMessage } from '../../packages/farm-protocol/src/channel.ts'
import { AuthenticatedBrowserSignallingClient } from '../../apps/farm/app/utils/webrtc/authenticated-signalling-client.ts'

type Input = Pick<
  SignallingIdentityInput,
  'accountId' | 'farmId' | 'origin' | 'audience'
>
type Assignment = Readonly<{
  assignmentId: string
  agentId: string
  printerKey: string
}>

/** Browser bundle entry for the HTTPS fixture. The private key stays in this page. */
export async function createSignallingRtcBrowserActor(input: Input) {
  const scope = Object.freeze({
    accountId: input.accountId,
    farmId: input.farmId,
    origin: input.origin,
    audience: input.audience,
  })
  BrowserDeviceTextId.parse(scope.accountId)
  BrowserDeviceUuid.parse(scope.farmId)
  PairingProofOrigin.parse(scope.origin)
  PairingProofAudience.parse(scope.audience)
  if (location.origin !== scope.origin) throw Error('Fixture origin mismatch')
  const keys = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const exported = await crypto.subtle.exportKey('jwk', keys.publicKey)
  const identity = await validateBrowserDevicePublicKey({
    kty: exported.kty,
    crv: exported.crv,
    x: exported.x,
    y: exported.y,
  })
  const publicJwk = Object.freeze({ ...identity.publicKey })
  let usedEnrollment = false,
    terminal = false,
    verifiedAdmission = false,
    acceptedStatusCount = 0
  let latestStatus: ReturnType<typeof StatusMessage.parse> | undefined
  let client: AuthenticatedBrowserSignallingClient | undefined
  return Object.freeze({
    publicJwk,
    async signEnrollment(input: unknown) {
      if (terminal || usedEnrollment) throw Error('Enrollment unavailable')
      const challenge = BrowserDeviceProofChallenge.parse(input),
        now = Date.now()
      if (
        challenge.purpose !== 'enroll' ||
        challenge.account_id !== scope.accountId ||
        challenge.farm_id !== scope.farmId ||
        challenge.origin !== scope.origin ||
        challenge.audience !== BROWSER_DEVICE_HTTP_AUDIENCE ||
        challenge.thumbprint !== identity.thumbprint ||
        now < challenge.issued_at ||
        now >= challenge.expires_at
      )
        throw Error('Enrollment scope mismatch')
      usedEnrollment = true
      const signature = await signBrowserDeviceProof(challenge, keys.privateKey)
      if (terminal || Date.now() >= challenge.expires_at)
        throw Error('Enrollment expired')
      return signature
    },
    start(input: {
      browserKeyId: string
      agentId: string
      assignmentRefs: readonly Assignment[]
    }) {
      if (terminal || client) throw Error('Client unavailable')
      const browserKeyId = BrowserDeviceUuid.parse(input.browserKeyId),
        agentId = BrowserDeviceUuid.parse(input.agentId)
      const refs = input.assignmentRefs.map((ref) => Object.freeze({ ...ref }))
      client = new AuthenticatedBrowserSignallingClient(
        {
          farmId: scope.farmId,
          agentId,
          keyId: browserKeyId,
          accountId: scope.accountId,
          origin: scope.origin,
          audience: scope.audience,
          publicKey: publicJwk,
          privateKey: keys.privateKey,
        },
        {
          genuineStatus: {
            assignmentRefs: refs,
            onStatus: (message) => {
              if (terminal || !verifiedAdmission)
                throw Error('Status before admission')
              const parsed = StatusMessage.parse(structuredClone(message))
              if (
                new TextEncoder().encode(JSON.stringify(parsed)).byteLength >
                2048
              )
                throw Error('Status limit')
              acceptedStatusCount = Math.min(acceptedStatusCount + 1, 1024)
              latestStatus = parsed
            },
          },
          onVerifiedAdmission: (admission) => {
            const b = admission.binding
            if (
              terminal ||
              b.account_id !== scope.accountId ||
              b.farm_id !== scope.farmId ||
              b.agent_id !== agentId ||
              b.key_id !== browserKeyId ||
              b.browser_thumbprint !== identity.thumbprint ||
              b.origin !== scope.origin ||
              b.audience !== scope.audience
            )
              throw Error('Admission scope mismatch')
            verifiedAdmission = true
          },
          onTerminal: () => {
            terminal = true
          },
        },
      )
      void client.start().catch(() => {
        terminal = true
      })
    },
    observe() {
      return {
        verifiedAdmission,
        acceptedStatusCount,
        latestStatus: latestStatus ? structuredClone(latestStatus) : undefined,
        terminal,
        diagnostics: client?.diagnostics(),
      }
    },
    close() {
      if (terminal) return
      terminal = true
      client?.close()
    },
  })
}
