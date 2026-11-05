import { z } from 'zod'
import type { FarmScope } from '../farm-view.ts'
import { listDeviceKeys, type LocalDeviceKey } from '../device-key.ts'
import { readBrowserDeviceScope } from '../browser-device-enrollment.ts'
import {
  BrowserDeviceHttpAccountResponse,
  BrowserDeviceHttpListResponse,
} from '../../../../../packages/farm-protocol/src/browser-device-http.ts'
import {
  BrowserDeviceUuid,
  BrowserDeviceTextId,
  validateBrowserDevicePublicKey,
} from '../../../../../packages/farm-protocol/src/browser-device-proof.ts'
import {
  PairingProofOrigin,
  PairingProofAudience,
} from '../../../../../packages/farm-protocol/src/pairing-proof.ts'

const Metadata = z.union([
  z.strictObject({
    enabled: z.literal(false),
    origin: z.null(),
    audience: z.null(),
  }),
  z.strictObject({
    enabled: z.literal(true),
    origin: PairingProofOrigin.refine((value) => value.startsWith('https://')),
    audience: PairingProofAudience,
  }),
])
type Input = { scope: FarmScope; browserKeyId: string; signal: AbortSignal }
type Options = {
  isCurrent: (scope: FarmScope, browserKeyId: string) => boolean
  currentOrigin?: () => string
  readMetadata?: (signal: AbortSignal) => Promise<unknown>
  readAccount?: (signal: AbortSignal) => Promise<unknown>
  readRegistryPage?: (
    farmId: string,
    signal: AbortSignal,
    after?: string,
  ) => Promise<unknown>
  listKeys?: (scope: {
    accountId: string
    farmId: string
  }) => Promise<LocalDeviceKey[]>
}
async function boundedRead(path: string, signal: AbortSignal) {
  const response = await fetch(path, {
    signal,
    cache: 'no-store',
    redirect: 'error',
    credentials: 'same-origin',
  })
  if (!response.ok || !response.body) throw Error('Unavailable')
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > 1024) throw Error('Response too large')
      chunks.push(part.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
}
/** Registry narrows local key selection; it never grants signalling admission. */
export function createFarmStatusKeyResolver(options: Options) {
  const currentOrigin = options.currentOrigin ?? (() => location.origin)
  const readMetadata =
    options.readMetadata ??
    ((signal) => boundedRead('/api/signalling/metadata', signal))
  const readAccount =
    options.readAccount ?? ((signal) => boundedRead('/api/auth/me', signal))
  const readRegistry = options.readRegistryPage ?? readBrowserDeviceScope
  const listKeys = options.listKeys ?? listDeviceKeys
  return async (input: Input) => {
    const scope = Object.freeze({ ...input.scope }),
      keyId = input.browserKeyId,
      signal = input.signal
    if (
      !BrowserDeviceTextId.safeParse(scope.accountId).success ||
      !BrowserDeviceUuid.safeParse(scope.farmId).success ||
      !Number.isSafeInteger(scope.viewEpoch) ||
      scope.viewEpoch < 0 ||
      !BrowserDeviceUuid.safeParse(keyId).success
    )
      throw Error('Unavailable')
    const check = () => {
      if (signal.aborted || !options.isCurrent(scope, keyId))
        throw Error('Unavailable')
    }
    const metadata = async () => {
      const value = Metadata.parse(await readMetadata(signal))
      check()
      if (!value.enabled || value.origin !== currentOrigin())
        throw Error('Unavailable')
      return value
    }
    check()
    const initial = await metadata()
    check()
    const account = BrowserDeviceHttpAccountResponse.parse(
      await readAccount(signal),
    )
    check()
    if (account.accountId !== scope.accountId) throw Error('Unavailable')
    const seen = new Set<string>(),
      cursors = new Set<string>()
    let after: string | undefined,
      selected:
        | z.infer<typeof BrowserDeviceHttpListResponse>['devices'][number]
        | undefined,
      complete = false
    for (let i = 0; i < 32; i++) {
      const page = BrowserDeviceHttpListResponse.parse(
        await readRegistry(scope.farmId, signal, after),
      )
      check()
      if (page.currentAccountId !== scope.accountId || page.devices.length > 20)
        throw Error('Unavailable')
      for (const device of page.devices) {
        if (seen.has(device.keyId)) throw Error('Unavailable')
        seen.add(device.keyId)
        if (device.keyId === keyId && device.accountId === scope.accountId)
          selected = device
      }
      if (page.nextAfter === null) {
        complete = true
        break
      }
      if (cursors.has(page.nextAfter)) throw Error('Unavailable')
      cursors.add(page.nextAfter)
      after = page.nextAfter
    }
    if (!complete || !selected || selected.status !== 'approved')
      throw Error('Unavailable')
    const keys = await listKeys({
      accountId: scope.accountId,
      farmId: scope.farmId,
    })
    check()
    if (keys.length > 32) throw Error('Unavailable')
    const matches = keys.filter((key) => key.thumbprint === selected.thumbprint)
    const item = matches[0]
    if (matches.length !== 1 || !item) throw Error('Unavailable')
    const record = {
      thumbprint: item.thumbprint,
      publicKey: structuredClone(item.publicKey),
      keyPair: {
        privateKey: item.keyPair.privateKey,
        publicKey: item.keyPair.publicKey,
      },
    }
    const privateKey = record.keyPair.privateKey,
      publicKey = record.keyPair.publicKey
    if (
      privateKey.type !== 'private' ||
      privateKey.extractable ||
      privateKey.algorithm.name !== 'ECDSA' ||
      !('namedCurve' in privateKey.algorithm) ||
      privateKey.algorithm.namedCurve !== 'P-256' ||
      publicKey.type !== 'public' ||
      publicKey.algorithm.name !== 'ECDSA' ||
      !('namedCurve' in publicKey.algorithm) ||
      publicKey.algorithm.namedCurve !== 'P-256'
    )
      throw Error('Unavailable')
    const parsed = await validateBrowserDevicePublicKey(record.publicKey)
    check()
    const exported = await crypto.subtle.exportKey('jwk', publicKey)
    check()
    const actual = await validateBrowserDevicePublicKey({
      kty: exported.kty,
      crv: exported.crv,
      x: exported.x,
      y: exported.y,
    })
    check()
    if (
      parsed.thumbprint !== record.thumbprint ||
      actual.thumbprint !== record.thumbprint
    )
      throw Error('Unavailable')
    const challenge = crypto.getRandomValues(new Uint8Array(32)),
      signature = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        privateKey,
        challenge,
      )
    check()
    if (
      !(await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        publicKey,
        signature,
        challenge,
      ))
    )
      throw Error('Unavailable')
    check()
    const finalAccount = BrowserDeviceHttpAccountResponse.parse(
      await readAccount(signal),
    )
    check()
    if (finalAccount.accountId !== scope.accountId) throw Error('Unavailable')
    const final = await metadata()
    check()
    if (final.origin !== initial.origin || final.audience !== initial.audience)
      throw Error('Unavailable')
    return {
      scope,
      keyId,
      localKey: record,
      origin: final.origin,
      audience: final.audience,
    }
  }
}
