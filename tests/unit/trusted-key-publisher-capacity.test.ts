import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import {
  decodeTrustedKeySetFrame,
  type TrustedBrowserKey,
  type TrustedIssuerKey,
} from '../../packages/farm-protocol/src/trusted-keys.ts'
import {
  createTrustedKeyPublisher,
  type TrustedKeyInboxes,
  type TrustedKeyRow,
  type TrustedKeySource,
} from '../../apps/farm/server/utils/trusted-keys/publisher.ts'

const NOW = 1_800_000_000_000
const issuerName = 'open3dfarm:trusted-key-issuer'

function farmId(index: number): string {
  const suffix = index.toString(16).padStart(12, '0')
  return `00000000-0000-4000-8000-${suffix}`
}

const spkiOf = async (key: CryptoKey) =>
  Buffer.from(await crypto.subtle.exportKey('spki', key)).toString('base64url')

async function browserKey(): Promise<TrustedBrowserKey> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )
  const { kty, crv, x, y } = await crypto.subtle.exportKey(
    'jwk',
    pair.publicKey,
  )
  const key = await validateBrowserDevicePublicKey({ kty, crv, x, y })
  return {
    key_id: randomUUID(),
    account_id: 'synthetic-account',
    thumbprint: key.thumbprint,
    public_key: key.publicKey,
  }
}

describe('trusted-key publisher farm capacity', () => {
  it('publishes a revocation on farm 300 after more than 256 farms were touched', async () => {
    const pair = await crypto.subtle.generateKey('Ed25519', false, [
      'sign',
      'verify',
    ])
    const issuer: TrustedIssuerKey = {
      issuer: issuerName,
      kid: 'issuer-1',
      public_key_spki: await spkiOf(pair.publicKey),
    }
    const rows = new Map<string, TrustedKeyRow[]>()
    const source: TrustedKeySource = {
      async read(farmId) {
        return {
          issuerKeys: [issuer],
          browserKeys: rows.get(farmId) ?? [],
        }
      },
    }
    const sent = new Map<string, string[]>()
    const proved: Array<(farmId: string) => void> = []
    const inboxes: TrustedKeyInboxes = {
      sendToFarmInboxes(farmId, wire) {
        const list = sent.get(farmId) ?? []
        list.push(wire)
        sent.set(farmId, list)
        return 1
      },
      onInboxProved(listener) {
        proved.push(listener)
        return () => {
          const index = proved.indexOf(listener)
          if (index >= 0) proved.splice(index, 1)
        }
      },
    }
    let wall = NOW
    const publisher = createTrustedKeyPublisher({
      source,
      inboxes,
      signer: {
        issuer: issuerName,
        kid: issuer.kid,
        signingKey: pair.privateKey,
      },
      clock: { wall: () => wall },
      timers: { every: () => () => {} },
    })

    const target = farmId(300)
    const approved = { ...(await browserKey()), farmId: target }
    rows.set(target, [approved])

    for (let index = 0; index <= 300; index++) {
      const id = farmId(index)
      if (id !== target) {
        rows.set(id, [{ ...(await browserKey()), farmId: id }])
      }
      wall += 1
      await publisher.notifyChange(id)
    }
    await publisher.idle()

    for (const listener of proved) listener(target)
    await publisher.idle()

    const before = sent.get(target) ?? []
    expect(before.length).toBeGreaterThan(0)
    const live = decodeTrustedKeySetFrame(before.at(-1)!).key_set
    expect(live.browser_keys.map((key) => key.key_id)).toEqual([
      approved.key_id,
    ])

    rows.set(target, [])
    wall += 1
    await publisher.notifyChange(target)
    await publisher.idle()

    const after = sent.get(target) ?? []
    const revoked = decodeTrustedKeySetFrame(after.at(-1)!).key_set
    expect(revoked.browser_keys).toEqual([])
    expect(revoked.version).toBeGreaterThan(live.version)

    publisher.close()
  })
})
