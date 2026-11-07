import { createBrowserKey } from '@open3dfarmmanager/farm-protocol'

const databaseName = 'open3dfarmmanager-device-keys'
const storeName = 'keys'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const storageError = () =>
  new Error('Browser device key storage unavailable or invalid')

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    let abandoned = false
    request.onupgradeneeded = () => request.result.createObjectStore(storeName)
    request.onerror = () => reject(storageError())
    request.onblocked = () => {
      abandoned = true
      reject(storageError())
    }
    request.onsuccess = () => {
      if (abandoned) {
        request.result.close()
        return
      }
      request.result.onversionchange = () => request.result.close()
      resolve(request.result)
    }
  })
}

/** Read and optional insert occur in one transaction; never overwrite a competing key. */
function readOrInsert(
  db: IDBDatabase,
  slot: string,
  candidate?: CryptoKeyPair,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, candidate ? 'readwrite' : 'readonly')
    const store = tx.objectStore(storeName)
    const request = store.get(slot)
    let value: unknown
    request.onsuccess = () => {
      value = request.result
      if (value === undefined && candidate) {
        value = {
          version: 1,
          privateKey: candidate.privateKey,
          publicKey: candidate.publicKey,
        }
        store.add(value, slot)
      }
    }
    tx.oncomplete = () => resolve(value)
    tx.onabort = () => reject(storageError())
    tx.onerror = () => reject(storageError())
  })
}

async function validate(value: unknown): Promise<CryptoKeyPair> {
  const row = value as {
    version: unknown
    privateKey: CryptoKey
    publicKey: CryptoKey
  }
  if (!row || row.version !== 1) throw storageError()
  for (const [key, type, usage, extractable] of [
    [row.privateKey, 'private', 'sign', false],
    [row.publicKey, 'public', 'verify', true],
  ] as const) {
    if (
      !(key instanceof CryptoKey) ||
      key.type !== type ||
      key.extractable !== extractable ||
      key.algorithm.name !== 'ECDSA' ||
      (key.algorithm as EcKeyAlgorithm).namedCurve !== 'P-256' ||
      key.usages.length !== 1 ||
      key.usages[0] !== usage
    )
      throw storageError()
  }
  // Detect an inconsistent stored pair using standard WebCrypto, without exporting the private key.
  const challenge = crypto.getRandomValues(new Uint8Array(32))
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    row.privateKey,
    challenge,
  )
  if (
    !(await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      row.publicKey,
      signature,
      challenge,
    ))
  )
    throw storageError()
  return { privateKey: row.privateKey, publicKey: row.publicKey }
}

/**
 * Explicit browser-only enrollment primitive. Scope must come from authenticated state.
 * No registration, authorization, remote revocation or automatic UI invocation is provided.
 * Corrupt or unavailable storage fails closed; there is no ephemeral key fallback.
 */
export async function loadOrCreateDeviceKey(scope: {
  farmId: string
  userId: string
}): Promise<CryptoKeyPair> {
  let db: IDBDatabase | undefined
  try {
    if (
      !uuid.test(scope.farmId) ||
      !uuid.test(scope.userId) ||
      !globalThis.isSecureContext
    )
      throw storageError()
    const slot = `${scope.farmId}:${scope.userId}`
    db = await openDatabase()
    const existing = await readOrInsert(db, slot)
    if (existing !== undefined) return await validate(existing)
    const candidate = await createBrowserKey()
    return await validate(await readOrInsert(db, slot, candidate))
  } catch {
    throw storageError()
  } finally {
    db?.close()
  }
}

/** Multiple keys are deliberate enrollments; the legacy default slot above is unchanged. */
export type DeviceKeyScope = { farmId: string; accountId: string }
export type LocalDeviceKey = {
  thumbprint: string
  publicKey: import('../../../../packages/farm-protocol/src/browser-device-proof.ts').BrowserDevicePublicKey
  keyPair: CryptoKeyPair
}

function scopePrefix(scope: DeviceKeyScope): string {
  if (
    !uuid.test(scope.farmId) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(scope.accountId) ||
    !globalThis.isSecureContext
  )
    throw storageError()
  return `enrollment:${scope.farmId}:${scope.accountId}:`
}

function scopedRows(
  db: IDBDatabase,
  prefix: string,
  candidate?: { slot: string; pair: CryptoKeyPair },
): Promise<{ slot: string; value: unknown }[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, candidate ? 'readwrite' : 'readonly')
    const store = tx.objectStore(storeName)
    const rows: { slot: string; value: unknown }[] = []
    const request = store.openCursor(
      IDBKeyRange.bound(prefix, `${prefix}\uffff`),
    )
    request.onsuccess = () => {
      const cursor = request.result
      if (cursor) {
        if (typeof cursor.key !== 'string' || rows.length >= 32) {
          tx.abort()
          return
        }
        rows.push({ slot: cursor.key, value: cursor.value })
        cursor.continue()
      } else if (candidate) {
        if (
          rows.length >= 32 ||
          rows.some((row) => row.slot === candidate.slot)
        ) {
          tx.abort()
          return
        }
        store.add(
          {
            version: 1,
            privateKey: candidate.pair.privateKey,
            publicKey: candidate.pair.publicKey,
          },
          candidate.slot,
        )
      }
    }
    tx.oncomplete = () => resolve(rows)
    tx.onabort = () => reject(storageError())
    tx.onerror = () => reject(storageError())
  })
}

async function localRecord(pair: CryptoKeyPair): Promise<LocalDeviceKey> {
  const { validateBrowserDevicePublicKey } =
    await import('../../../../packages/farm-protocol/src/browser-device-proof.ts')
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const canonical = await validateBrowserDevicePublicKey({
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
  })
  return { ...canonical, keyPair: pair }
}

/** Bounded, fail-closed enumeration. Never creates, deletes, repairs or substitutes keys. */
export async function listDeviceKeys(
  scope: DeviceKeyScope,
): Promise<LocalDeviceKey[]> {
  let db: IDBDatabase | undefined
  try {
    const prefix = scopePrefix(scope)
    db = await openDatabase()
    const rows = await scopedRows(db, prefix)
    const result: LocalDeviceKey[] = []
    for (const row of rows) {
      const record = await localRecord(await validate(row.value))
      if (row.slot !== prefix + record.thumbprint) throw storageError()
      result.push(record)
    }
    return result
  } catch {
    throw storageError()
  } finally {
    db?.close()
  }
}

/** Call only after an explicit user action. Existing enrollments are never overwritten. */
export async function createDeviceKey(
  scope: DeviceKeyScope,
): Promise<LocalDeviceKey> {
  let db: IDBDatabase | undefined
  try {
    const prefix = scopePrefix(scope)
    // Corruption must not be bypassed by creating another slot.
    await listDeviceKeys(scope)
    const record = await localRecord(await createBrowserKey())
    db = await openDatabase()
    const rows = await scopedRows(db, prefix, {
      slot: prefix + record.thumbprint,
      pair: record.keyPair,
    })
    // Check all records observed by the serialized insertion, including concurrent additions.
    for (const row of rows) {
      const existing = await localRecord(await validate(row.value))
      if (row.slot !== prefix + existing.thumbprint) throw storageError()
    }
    return record
  } catch {
    throw storageError()
  } finally {
    db?.close()
  }
}
