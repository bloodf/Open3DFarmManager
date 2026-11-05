import {
  constants,
  type Stats,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  fsyncSync,
  linkSync,
  unlinkSync,
  existsSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  createHash,
  sign,
  type KeyObject,
} from 'node:crypto'

import { signPairingProof } from './pairing-proof.ts'
import { signCredentialProof } from './credential-proof.ts'

const KEY_FILE = 'identity.json'
const LIMIT = 1024
function privateEntry(stat: Stats, directory = false) {
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
  )
    throw new Error('Identity storage requires regular private files')
  if (
    process.platform !== 'win32' &&
    ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
  )
    throw new Error(
      'Identity storage must be private and owned by the current user',
    )
}
function syncDirectory(directory: string) {
  const fd = openSync(directory, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

export class ConnectorIdentity {
  readonly fingerprint: string
  readonly publicKeySpki: string
  #key: KeyObject
  constructor(key: KeyObject) {
    if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519')
      throw new Error('Expected an Ed25519 private key')
    this.#key = key
    const publicDer = createPublicKey(key).export({
      format: 'der',
      type: 'spki',
    })
    this.publicKeySpki = publicDer.toString('base64url')
    this.fingerprint =
      'SHA256:' + createHash('sha256').update(publicDer).digest('base64url')
  }
  // Domain-separated proof only. Not a printer-command signer or an authorization decision.
  signProof(challenge: Uint8Array): string {
    if (!(challenge instanceof Uint8Array) || challenge.byteLength !== 32)
      throw new Error('Proof challenge must contain exactly 32 bytes')
    const message = Buffer.concat([
      Buffer.from('Open3DFarmManager/connector-proof/v1\0'),
      Buffer.from(challenge),
    ])
    return sign(null, message, this.#key).toString('base64url')
  }
  /** Signs only the validated pairing domain, retaining the existing private key internally. */
  signCredentialProof(
    input: Omit<Parameters<typeof signCredentialProof>[0], 'privateKey'>,
  ): string {
    return signCredentialProof({ ...input, privateKey: this.#key })
  }
  signPairingProof(
    input: Omit<Parameters<typeof signPairingProof>[0], 'privateKey'>,
  ): string {
    return signPairingProof({ ...input, privateKey: this.#key })
  }
  toJSON() {
    return {
      algorithm: 'Ed25519',
      fingerprint: this.fingerprint,
      publicKeySpki: this.publicKeySpki,
    }
  }
}

function readIdentity(path: string): ConnectorIdentity {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const stat = fstatSync(fd)
    privateEntry(stat)
    if (stat.size > LIMIT) throw new Error('Identity file exceeds size limit')
    const data = readFileSync(fd)
    const text = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(data)
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      throw new Error('Invalid identity JSON')
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid identity format')
    const stored = value as Record<string, unknown>
    if (
      Object.keys(stored).sort().join(',') !== 'privateKey,version' ||
      stored.version !== 1 ||
      typeof stored.privateKey !== 'string' ||
      !/^[A-Za-z0-9_-]{64}$/.test(stored.privateKey)
    )
      throw new Error('Invalid identity format')
    // The writer has one representation; alternate or duplicate fields fail closed.
    if (
      JSON.stringify({ version: 1, privateKey: stored.privateKey }) + '\n' !==
      text
    )
      throw new Error('Noncanonical identity file')
    const der = Buffer.from(stored.privateKey, 'base64url')
    const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
    if (!key.export({ format: 'der', type: 'pkcs8' }).equals(der))
      throw new Error('Noncanonical private key')
    return new ConnectorIdentity(key)
  } finally {
    closeSync(fd)
  }
}

/** Read-only lookup: never creates a directory, lock or identity. */
export function loadExistingIdentity(directory: string): ConnectorIdentity {
  if (process.platform === 'win32')
    throw new Error('Windows identity permissions need an ACL implementation')
  privateEntry(lstatSync(directory), true)
  return readIdentity(join(directory, KEY_FILE))
}

/** Initializes only when explicitly called. Never replaces an existing or corrupt identity. */
export function loadOrCreateIdentity(directory: string): ConnectorIdentity {
  if (process.platform === 'win32')
    throw new Error('Windows identity permissions need an ACL implementation')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  privateEntry(lstatSync(directory), true)
  const path = join(directory, KEY_FILE)
  try {
    return readIdentity(path)
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    )
      throw error
  }
  const lock = join(directory, 'identity.init.lock')
  const temporary = join(directory, 'identity.pending')
  const lockFd = openSync(lock, 'wx', 0o600)
  let pendingCreated = false
  try {
    writeFileSync(lockFd, 'initializing\n')
    fsyncSync(lockFd)
    syncDirectory(directory)
    // A competing initializer may have completed before this lock was acquired.
    try {
      return readIdentity(path)
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      )
        throw error
    }
    // An orphan may hold an already-generated identity: never discard or rotate it silently.
    if (existsSync(temporary))
      throw new Error('Pending identity requires explicit recovery')
    const { privateKey } = generateKeyPairSync('ed25519')
    const encoded = privateKey
      .export({ format: 'der', type: 'pkcs8' })
      .toString('base64url')
    const fd = openSync(temporary, 'wx', 0o600)
    pendingCreated = true
    try {
      writeFileSync(
        fd,
        JSON.stringify({ version: 1, privateKey: encoded }) + '\n',
      )
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    // Hard-link publication is atomic and refuses to overwrite an existing path.
    linkSync(temporary, path)
    unlinkSync(temporary)
    pendingCreated = false
    syncDirectory(directory)
    return readIdentity(path)
  } finally {
    closeSync(lockFd)
    // Failed writes retain the pending file for recovery, preventing silent key regeneration.
    if (!pendingCreated) {
      unlinkSync(lock)
      syncDirectory(directory)
    }
  }
}
