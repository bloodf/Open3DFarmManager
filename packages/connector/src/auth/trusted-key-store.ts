import { constants } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  decodeTrustedKeySetFrame,
  MAX_TRUSTED_KEY_SET_WIRE_BYTES,
  verifyTrustedKeySet,
  type SignedTrustedKeySetV1,
} from '../../../farm-protocol/src/trusted-keys.ts'
import {
  importPauseIssuerEntries,
  MAX_PAUSE_ISSUER_KEYRING,
} from '../config/pause.ts'
import type {
  PauseIssuer,
  PauseCapabilitySnapshot,
} from './pause-capability.ts'

export interface TrustedKeyAuthority {
  issuer(issuer: string, kid: string): CryptoKey | undefined
  allowsBrowser(
    capability: Pick<
      PauseCapabilitySnapshot,
      'farm_id' | 'account_id' | 'key_id' | 'browser_thumbprint'
    >,
  ): boolean
}

async function importIssuers(set: SignedTrustedKeySetV1) {
  return importPauseIssuerEntries(
    set.issuer_keys.map((key) => ({
      issuer: key.issuer,
      kid: key.kid,
      publicKeySpki: key.public_key_spki,
    })),
  )
}

/** One owner per private path. The private checkpoint is local trust state, like
 * the configured keyring; network updates never trust their embedded signer. */
export async function openTrustedKeyStore(options: {
  path: string
  farmId: string
  issuers: readonly PauseIssuer[]
  onDiagnostic?: (code: 'trusted-keys-storage-invalid') => void
}) {
  const anchors = options.issuers.map((entry) => Object.freeze({ ...entry }))
  if (
    !anchors.length ||
    anchors.length > MAX_PAUSE_ISSUER_KEYRING ||
    new Set(anchors.map((key) => key.issuer + '\0' + key.kid)).size !==
      anchors.length
  )
    throw new Error('Invalid trusted issuer keyring')
  let current:
    | {
        wire: string
        set: SignedTrustedKeySetV1
        issuers: readonly PauseIssuer[]
      }
    | undefined
  let failed = false
  let chain = Promise.resolve()
  function fail(): never {
    failed = true
    try {
      options.onDiagnostic?.('trusted-keys-storage-invalid')
    } catch {
      /* Observational only. */
    }
    throw new Error('Trusted key storage unavailable')
  }
  // The restore marker lives outside the checkpoint. Restarting after a restore
  // starts with no browser grants and no version floor from the previous server.
  let checkpoint = options.path
  try {
    const marker = await open(
      join(dirname(options.path), 'trusted-keys.epoch'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    try {
      const stat = await marker.stat()
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        (stat.mode & 0o777) !== 0o600 ||
        stat.uid !== process.getuid?.() ||
        stat.size !== 36
      )
        fail()
      const epoch = await marker.readFile('utf8')
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          epoch,
        )
      )
        fail()
      checkpoint = options.path + '.' + epoch
    } finally {
      await marker.close()
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      fail()
  }
  const lookup = (keys: readonly PauseIssuer[], issuer: string, kid: string) =>
    keys.find((key) => key.issuer === issuer && key.kid === kid)?.publicKey
  async function decode(wire: string) {
    const set = decodeTrustedKeySetFrame(wire).key_set
    if (set.farm_id !== options.farmId)
      throw new Error('Trusted key scope mismatch')
    const names = new Set(anchors.map((key) => key.issuer + '\0' + key.kid))
    for (const key of set.issuer_keys) names.add(key.issuer + '\0' + key.kid)
    if (names.size > MAX_PAUSE_ISSUER_KEYRING)
      throw new Error('Trusted issuer keyring limit exceeded')
    return { wire, set, issuers: await importIssuers(set) }
  }
  try {
    const file = await open(
      checkpoint,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    )
    try {
      const stat = await file.stat()
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        (stat.mode & 0o777) !== 0o600 ||
        (process.getuid && stat.uid !== process.getuid()) ||
        stat.size > MAX_TRUSTED_KEY_SET_WIRE_BYTES
      )
        throw new Error('Invalid checkpoint')
      const bytes = Buffer.alloc(MAX_TRUSTED_KEY_SET_WIRE_BYTES + 1)
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
      if (bytesRead > MAX_TRUSTED_KEY_SET_WIRE_BYTES)
        throw new Error('Invalid checkpoint')
      const restored = await decode(
        bytes.subarray(0, bytesRead).toString('utf8'),
      )
      const key = lookup(
        restored.issuers,
        restored.set.issuer,
        restored.set.kid,
      )
      if (!key || !(await verifyTrustedKeySet(restored.set, key)))
        throw new Error('Invalid checkpoint')
      current = restored
    } finally {
      await file.close()
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      fail()
  }
  const authority: TrustedKeyAuthority = Object.freeze<TrustedKeyAuthority>({
    issuer(issuer: string, kid: string) {
      if (failed) return undefined
      return (
        lookup(current?.issuers ?? [], issuer, kid) ??
        lookup(anchors, issuer, kid)
      )
    },
    allowsBrowser(capability) {
      if (failed || capability.farm_id !== options.farmId) return false
      return !!current?.set.browser_keys.some(
        (key) =>
          key.key_id === capability.key_id &&
          key.account_id === capability.account_id &&
          key.thumbprint === capability.browser_thumbprint,
      )
    },
  })
  return Object.freeze({
    authority,
    get version() {
      return current?.set.version
    },
    /** Await before treating an inbox confirmation as applied. Serialized across fsync. */
    confirm(wire: string): Promise<boolean> {
      const run = chain.then(async () => {
        if (failed) throw new Error('Trusted key storage unavailable')
        const next = await decode(wire)
        if (current && next.set.version <= current.set.version)
          return (
            next.set.version === current.set.version && wire === current.wire
          )
        const key = authority.issuer(next.set.issuer, next.set.kid)
        if (!key || !(await verifyTrustedKeySet(next.set, key))) return false
        // The checkpoint must remain verifiable after restart, even after rotation.
        const embedded = lookup(next.issuers, next.set.issuer, next.set.kid)
        if (!embedded || !(await verifyTrustedKeySet(next.set, embedded)))
          return false
        const temporary = join(
          dirname(options.path),
          `.trusted-keys-${randomUUID()}.tmp`,
        )
        try {
          const file = await open(temporary, 'wx', 0o600)
          try {
            await file.writeFile(wire)
            await file.sync()
          } finally {
            await file.close()
          }
          await rename(temporary, checkpoint)
          const directory = await open(
            dirname(options.path),
            constants.O_RDONLY | constants.O_DIRECTORY,
          )
          try {
            await directory.sync()
          } finally {
            await directory.close()
          }
          current = next
          return true
        } catch {
          return fail()
        } finally {
          await unlink(temporary).catch(() => {})
        }
      })
      chain = run.then(
        () => {},
        () => {},
      )
      return run
    },
  })
}
export type TrustedKeyStore = Awaited<ReturnType<typeof openTrustedKeyStore>>
