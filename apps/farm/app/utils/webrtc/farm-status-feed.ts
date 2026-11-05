import { assignmentSetDigest } from '../../../../../packages/farm-protocol/src/rtc-assignment-set.ts'
import type {
  FarmStatusFeed,
  FarmScope,
  FarmAdmittedSession,
} from '../farm-view.ts'
import type { LocalDeviceKey } from '../device-key.ts'
import {
  BrowserDeviceUuid,
  BrowserDeviceTextId,
  validateBrowserDevicePublicKey,
} from '../../../../../packages/farm-protocol/src/browser-device-proof.ts'
import { StatusMessage } from '../../../../../packages/farm-protocol/src/channel.ts'
import { RtcSessionBinding } from '../../../../../packages/farm-protocol/src/rtc-session-binding.ts'
import { AuthenticatedBrowserSignallingClient } from './authenticated-signalling-client.ts'

type Assignment = { assignmentId: string; agentId: string; printerKey: string }
type ResolvedKey = {
  scope: FarmScope
  keyId: string
  localKey: LocalDeviceKey
  origin: string
  audience: string
}
type Client = { start(): Promise<void>; close(): void }
type ClientInput = {
  scope: {
    farmId: string
    agentId: string
    keyId: string
    accountId: string
    origin: string
    audience: string
    publicKey: unknown
    privateKey: CryptoKey
  }
  assignmentRefs: readonly Assignment[]
  onVerifiedAdmission: (value: {
    binding: RtcSessionBinding
    deadlineMonoMs: number
  }) => void
  onStatus: (value: unknown) => void
  onTerminal: (reason: string) => void
}
type Options = {
  resolveKey: (input: {
    scope: FarmScope
    browserKeyId: string
    signal: AbortSignal
  }) => Promise<ResolvedKey>
  createClient?: (input: ClientInput) => Client
}
function requireSync(callback: () => void) {
  const result: unknown = callback()
  if (result !== undefined) {
    void Promise.resolve(result).catch(() => {})
    throw Error('Callback must return synchronously')
  }
}
let generation = 0

/** Injection only. The caller supplies existing keys; current authorization remains server-owned. */
export function createAuthenticatedFarmStatusFeed(
  options: Options,
): FarmStatusFeed {
  const active = new Map<string, () => void>()
  return {
    open(input) {
      const scope = Object.freeze({ ...input.scope })
      const refs = Object.freeze(
        input.assignmentRefs.map((ref) =>
          Object.freeze({
            assignmentId: ref.assignmentId,
            agentId: ref.agentId,
            printerKey: ref.printerKey,
          }),
        ),
      )
      const agentId = input.agentId,
        keyId = input.browserKeyId
      const signal = input.signal,
        onHealth = input.onHealth,
        onSnapshot = input.onSnapshot
      const slot = JSON.stringify([scope.accountId, scope.farmId, agentId])
      const peerGeneration = ++generation
      const controller = new AbortController()
      const started = performance.now(),
        wallStarted = Date.now()
      const authDeadline = started + 8000,
        lifetimeDeadline = started + 30000
      let terminal = false,
        client: Client | undefined,
        session: FarmAdmittedSession | undefined,
        seq = -1
      let authTimer: ReturnType<typeof setTimeout>,
        lifeTimer: ReturnType<typeof setTimeout>
      const current = () =>
        !terminal &&
        !controller.signal.aborted &&
        !signal.aborted &&
        performance.now() < lifetimeDeadline &&
        (!session
          ? performance.now() < authDeadline
          : performance.now() < session.deadlineMonoMs &&
            Date.now() < session.expiresAt)
      const close = (
        reason:
          | 'expired'
          | 'revoked'
          | 'disconnected'
          | 'rejected' = 'disconnected',
      ) => {
        if (terminal) return
        terminal = true
        clearTimeout(authTimer)
        clearTimeout(lifeTimer)
        signal.removeEventListener('abort', aborted)
        if (active.get(slot) === retire) active.delete(slot)
        controller.abort()
        try {
          client?.close()
        } catch {}
        try {
          requireSync(() => onHealth({ kind: 'closed', reason }))
        } catch {}
      }
      const retire = () => close('disconnected')
      const aborted = retire
      authTimer = setTimeout(() => close('expired'), 8000)
      lifeTimer = setTimeout(() => close('expired'), 30000)
      signal.addEventListener('abort', aborted, { once: true })
      if (
        !Number.isSafeInteger(peerGeneration) ||
        !Number.isSafeInteger(scope.viewEpoch) ||
        scope.viewEpoch < 0 ||
        !BrowserDeviceUuid.safeParse(scope.farmId).success ||
        !BrowserDeviceUuid.safeParse(agentId).success ||
        !BrowserDeviceUuid.safeParse(keyId).success ||
        !BrowserDeviceTextId.safeParse(scope.accountId).success ||
        refs.length === 0 ||
        refs.length > 100 ||
        refs.some(
          (ref) =>
            ref.agentId !== agentId ||
            !BrowserDeviceUuid.safeParse(ref.assignmentId).success ||
            !ref.printerKey ||
            ref.printerKey.length > 128 ||
            ref.printerKey.includes('\0') ||
            /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
              ref.printerKey,
            ),
        ) ||
        new Set(refs.map((ref) => ref.assignmentId)).size !== refs.length ||
        new Set(refs.map((ref) => ref.printerKey)).size !== refs.length ||
        signal.aborted
      ) {
        close('rejected')
        return { close }
      }
      active.get(slot)?.()
      if (active.has(slot) || active.size >= 100) {
        close('rejected')
        return { close }
      }
      active.set(slot, retire)
      try {
        requireSync(() => onHealth({ kind: 'connecting' }))
      } catch {
        close('rejected')
      }
      void (async () => {
        try {
          if (!current()) return close('expired')
          const result = await options.resolveKey({
            scope,
            browserKeyId: keyId,
            signal: controller.signal,
          })
          if (!current()) return
          const resolved = {
            scope: { ...result.scope },
            keyId: result.keyId,
            origin: result.origin,
            audience: result.audience,
            thumbprint: result.localKey.thumbprint,
            publicKey: structuredClone(result.localKey.publicKey),
            privateKey: result.localKey.keyPair.privateKey,
            publicCryptoKey: result.localKey.keyPair.publicKey,
          }
          if (
            resolved.scope.accountId !== scope.accountId ||
            resolved.scope.farmId !== scope.farmId ||
            resolved.scope.viewEpoch !== scope.viewEpoch ||
            resolved.keyId !== keyId ||
            resolved.privateKey.type !== 'private' ||
            resolved.privateKey.extractable ||
            resolved.privateKey.algorithm.name !== 'ECDSA' ||
            !('namedCurve' in resolved.privateKey.algorithm) ||
            resolved.privateKey.algorithm.namedCurve !== 'P-256' ||
            resolved.publicCryptoKey.type !== 'public' ||
            resolved.publicCryptoKey.algorithm.name !== 'ECDSA' ||
            !('namedCurve' in resolved.publicCryptoKey.algorithm) ||
            resolved.publicCryptoKey.algorithm.namedCurve !== 'P-256'
          )
            throw Error('Key scope mismatch')
          const key = await validateBrowserDevicePublicKey(resolved.publicKey)
          if (!current()) return
          const exported = await crypto.subtle.exportKey(
            'jwk',
            resolved.publicCryptoKey,
          )
          if (!current()) return
          const actual = await validateBrowserDevicePublicKey({
            kty: exported.kty,
            crv: exported.crv,
            x: exported.x,
            y: exported.y,
          })
          if (!current()) return
          if (
            key.thumbprint !== resolved.thumbprint ||
            key.thumbprint !== actual.thumbprint
          )
            throw Error('Key mismatch')
          const challenge = crypto.getRandomValues(new Uint8Array(32))
          const signature = await crypto.subtle.sign(
            { name: 'ECDSA', hash: 'SHA-256' },
            resolved.privateKey,
            challenge,
          )
          if (!current()) return
          if (
            !(await crypto.subtle.verify(
              { name: 'ECDSA', hash: 'SHA-256' },
              resolved.publicCryptoKey,
              signature,
              challenge,
            ))
          )
            throw Error('Key pair mismatch')
          if (!current()) return
          const assignments = await assignmentSetDigest(
            { farmId: scope.farmId, agentId },
            refs,
          )
          if (!current()) return
          const create =
            options.createClient ??
            ((value: ClientInput) =>
              new AuthenticatedBrowserSignallingClient(value.scope, {
                genuineStatus: {
                  assignmentRefs: value.assignmentRefs,
                  onStatus: value.onStatus,
                },
                onVerifiedAdmission: value.onVerifiedAdmission,
                onTerminal: value.onTerminal,
              }))
          const made = create({
            scope: {
              farmId: scope.farmId,
              agentId,
              keyId,
              accountId: scope.accountId,
              origin: resolved.origin,
              audience: resolved.audience,
              publicKey: key.publicKey,
              privateKey: resolved.privateKey,
            },
            assignmentRefs: refs,
            onVerifiedAdmission(value) {
              if (!current() || session) return close('rejected')
              try {
                const b = RtcSessionBinding.parse(
                    structuredClone(value.binding),
                  ),
                  now = performance.now(),
                  wall = Date.now()
                if (
                  b.v !== 2 ||
                  b.assignment_count !== assignments.count ||
                  b.assignment_digest !== assignments.digest ||
                  b.account_id !== scope.accountId ||
                  b.farm_id !== scope.farmId ||
                  b.agent_id !== agentId ||
                  b.key_id !== keyId ||
                  b.browser_thumbprint !== key.thumbprint ||
                  b.origin !== resolved.origin ||
                  b.audience !== resolved.audience ||
                  wall < b.issued_at ||
                  wall >= b.expires_at ||
                  !Number.isFinite(value.deadlineMonoMs) ||
                  value.deadlineMonoMs <= now
                )
                  return close('rejected')
                session = Object.freeze({
                  transportId: b.transport_id,
                  peerGeneration,
                  accountId: scope.accountId,
                  farmId: scope.farmId,
                  agentId,
                  browserKeyId: keyId,
                  expiresAt: b.expires_at,
                  deadlineMonoMs: Math.min(
                    lifetimeDeadline,
                    value.deadlineMonoMs,
                    now + b.expires_at - wall,
                  ),
                })
                clearTimeout(authTimer)
                clearTimeout(lifeTimer)
                lifeTimer = setTimeout(
                  () => close('expired'),
                  Math.max(0, session.deadlineMonoMs - performance.now()),
                )
                try {
                  const snapshot = Object.freeze({ ...session })
                  requireSync(() =>
                    onHealth({ kind: 'authenticated', session: snapshot }),
                  )
                } catch {
                  close('rejected')
                }
              } catch {
                close('rejected')
              }
            },
            onStatus(value) {
              if (!current() || !session) return close('rejected')
              try {
                const parsed = StatusMessage.safeParse(structuredClone(value))
                if (
                  !parsed.success ||
                  !Number.isSafeInteger(parsed.data.seq) ||
                  parsed.data.seq <= seq ||
                  parsed.data.printers.length !== refs.length ||
                  new Set(parsed.data.printers.map((p) => p.printerKey))
                    .size !== refs.length ||
                  parsed.data.printers.some(
                    (p) =>
                      !refs.some((ref) => ref.printerKey === p.printerKey) ||
                      !Number.isSafeInteger(p.observedAt),
                  ) ||
                  new TextEncoder().encode(JSON.stringify(parsed.data))
                    .byteLength > 2048
                )
                  return close('rejected')
                const now = performance.now(),
                  wall = Date.now()
                if (now < started || wall < wallStarted || !current())
                  return close('expired')
                seq = parsed.data.seq
                try {
                  const admitted = session
                  const message = parsed.data
                  for (const printer of message.printers) Object.freeze(printer)
                  Object.freeze(message.printers)
                  Object.freeze(message)
                  requireSync(() =>
                    onSnapshot(
                      Object.freeze({
                        session: Object.freeze({ ...admitted }),
                        message,
                        receivedAtWallMs: wall,
                        receivedAtMonoMs: now,
                        sourceClockComparable: false,
                        complete: true,
                      }),
                    ),
                  )
                } catch {
                  close('rejected')
                }
              } catch {
                close('rejected')
              }
            },
            onTerminal() {
              close('disconnected')
            },
          })
          if (!current()) {
            made.close()
            return
          }
          client = made
          try {
            requireSync(() => onHealth({ kind: 'verifying' }))
          } catch {
            return close('rejected')
          }
          if (!current()) return
          await client.start()
          if (!current()) return
        } catch {
          close('rejected')
        }
      })()
      return { close }
    },
  }
}
