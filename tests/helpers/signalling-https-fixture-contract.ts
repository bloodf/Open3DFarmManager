import type { BrowserContext, Page } from '@playwright/test'
import type {
  BrowserDeviceProofChallenge,
  BrowserDevicePublicKey,
} from '../../packages/farm-protocol/src/browser-device-proof.ts'
import type { PairingProofChallenge } from '../../packages/farm-protocol/src/pairing-proof.ts'
import type { PairingPollResponse } from '../../packages/farm-protocol/src/pairing.ts'

export type FixtureIdentityHandles = Readonly<{
  browser: Readonly<{
    publicJwk: Readonly<BrowserDevicePublicKey>
    signEnrollment(challenge: BrowserDeviceProofChallenge): Promise<string>
  }>
  connector: Readonly<{
    publicKeySpki: string
    fingerprint: string
    signPairing(
      challenge: PairingProofChallenge,
      origin: string,
      audience: string,
    ): Promise<string>
  }>
  dispose(): Promise<void>
}>
export type SignallingIdentityInput = Readonly<{
  origin: string
  audience: string
  caPath: string
  ownerPage: Page
  ownerContext: BrowserContext
  adminPage: Page
  accountId: string
  farmId: string
  signal: AbortSignal
}>
export type ProvisionedSignallingFixture = SignallingIdentityInput &
  Readonly<{
    browserKeyId: string
    browserThumbprint: string
    claim: Extract<PairingPollResponse, { status: 'approved' }>
    assignmentRefs: readonly Readonly<{
      assignmentId: string
      agentId: string
      printerKey: string
    }>[]
    identities: FixtureIdentityHandles
    revokeConnector(): Promise<void>
    disconnectSignalling(): Promise<void>
  }>
export type SignallingFixtureExtension = Readonly<{
  identityHandles(
    input: SignallingIdentityInput,
  ): Promise<FixtureIdentityHandles>
  afterProvisioned(input: ProvisionedSignallingFixture): Promise<void>
}>
