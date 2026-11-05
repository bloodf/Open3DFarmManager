import { createHash, createPublicKey } from 'node:crypto'
import { calculateJwkThumbprint, jwtVerify, SignJWT } from 'jose'
import {
  PairingPublicKey,
  parseBoundedJson,
} from '@open3dfarmmanager/farm-protocol'

/** Prototype policy: caller must choose an explicit lifetime between 1 and 3600 seconds. */
export interface ConnectorCredentialIssuerConfig {
  issuer: string
  audience: string
  kid: string
  privateKey: CryptoKey
  ttlSeconds: number
}
type Binding = { agentId: string; farmId: string; publicKeySpki: string }
type IssueInput = ConnectorCredentialIssuerConfig &
  Binding & { nowSeconds: number; jti: string }
type VerifyInput = Binding & {
  token: string
  issuer: string
  audience: string
  publicKeys: ReadonlyMap<string, CryptoKey>
  ttlSeconds: number
  nowSeconds: number
}
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const kidPattern = /^[A-Za-z0-9_-]{1,64}$/

function validConfig(
  issuer: string,
  audience: string,
  ttl: number,
  now: number,
) {
  if (
    !issuer ||
    issuer.length > 256 ||
    !audience ||
    audience.length > 256 ||
    !Number.isSafeInteger(ttl) ||
    ttl < 1 ||
    ttl > 3600 ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    now > 8_640_000_000_000 - ttl
  )
    throw new Error('Invalid credential configuration')
}
function validBinding(binding: Binding) {
  if (!uuid.test(binding.agentId) || !uuid.test(binding.farmId))
    throw new Error('Invalid credential binding')
  PairingPublicKey.parse(binding.publicKeySpki)
}
function validKey(key: CryptoKey, type: 'public' | 'private') {
  if (
    key.type !== type ||
    key.algorithm.name !== 'Ed25519' ||
    !key.usages.includes(type === 'private' ? 'sign' : 'verify')
  )
    throw new Error('Invalid credential key')
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  )
}
function parseSegment(segment: string): unknown {
  const bytes = Buffer.from(segment, 'base64url')
  if (bytes.toString('base64url') !== segment)
    throw new Error('Noncanonical credential encoding')
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  return parseBoundedJson(text, {
    maxBytes: 8192,
    maxDepth: 4,
    maxValues: 32,
    maxStringChars: 1024,
  })
}
/** Computes both identifiers from the same validated persisted Ed25519 SPKI. */
export async function connectorKeyBinding(
  publicKeySpki: string,
): Promise<{ fingerprint: string; thumbprint: string }> {
  PairingPublicKey.parse(publicKeySpki)
  const der = Buffer.from(publicKeySpki, 'base64url')
  const key = createPublicKey({ key: der, format: 'der', type: 'spki' })
  const jwk = key.export({ format: 'jwk' })
  return {
    fingerprint:
      'SHA256:' + createHash('sha256').update(der).digest('base64url'),
    thumbprint: await calculateJwkThumbprint(jwk),
  }
}
/** Only signs a credential. The caller owns durable issuance and unique jti generation. */
export async function issueConnectorCredential(
  input: IssueInput,
): Promise<string> {
  validConfig(input.issuer, input.audience, input.ttlSeconds, input.nowSeconds)
  validBinding(input)
  validKey(input.privateKey, 'private')
  if (!kidPattern.test(input.kid) || !uuid.test(input.jti))
    throw new Error('Invalid credential identity')
  const binding = await connectorKeyBinding(input.publicKeySpki)
  return new SignJWT({
    farm_id: input.farmId,
    fingerprint: binding.fingerprint,
    cnf: { jkt: binding.thumbprint },
  })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid: input.kid })
    .setIssuer(input.issuer)
    .setAudience(input.audience)
    .setSubject(input.agentId)
    .setIssuedAt(input.nowSeconds)
    .setExpirationTime(input.nowSeconds + input.ttlSeconds)
    .setJti(input.jti)
    .sign(input.privateKey)
}
/** Cryptography only: the caller must check current enrollment and fresh proof of possession. */
export async function verifyConnectorCredential(input: VerifyInput): Promise<{
  agentId: string
  farmId: string
  fingerprint: string
  thumbprint: string
  jti: string
  issuedAt: number
  expiresAt: number
}> {
  validConfig(input.issuer, input.audience, input.ttlSeconds, input.nowSeconds)
  validBinding(input)
  if (typeof input.token !== 'string' || input.token.length > 8192)
    throw new Error('Invalid credential')
  const parts = input.token.split('.')
  if (
    parts.length !== 3 ||
    parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
  )
    throw new Error('Invalid credential')
  const [head, body, signature] = parts
  if (!head || !body || !signature) throw new Error('Invalid credential')
  const header = parseSegment(head)
  const untrusted = parseSegment(body)
  if (
    Buffer.from(signature, 'base64url').toString('base64url') !== signature ||
    !object(header) ||
    !exactKeys(header, ['alg', 'typ', 'kid']) ||
    header.alg !== 'EdDSA' ||
    header.typ !== 'JWT' ||
    typeof header.kid !== 'string' ||
    !kidPattern.test(header.kid) ||
    !object(untrusted)
  )
    throw new Error('Invalid credential header')
  const key = input.publicKeys.get(header.kid)
  if (!key) throw new Error('Unknown credential key')
  validKey(key, 'public')
  const { payload } = await jwtVerify(input.token, key, {
    algorithms: ['EdDSA'],
    issuer: input.issuer,
    audience: input.audience,
    requiredClaims: ['iss', 'aud', 'sub', 'iat', 'exp', 'jti'],
    currentDate: new Date(input.nowSeconds * 1000),
  })
  const binding = await connectorKeyBinding(input.publicKeySpki)
  if (
    !exactKeys(payload, [
      'iss',
      'aud',
      'sub',
      'iat',
      'exp',
      'jti',
      'farm_id',
      'fingerprint',
      'cnf',
    ]) ||
    payload.iss !== input.issuer ||
    payload.aud !== input.audience ||
    payload.sub !== input.agentId ||
    payload.farm_id !== input.farmId ||
    payload.fingerprint !== binding.fingerprint ||
    !object(payload.cnf) ||
    !exactKeys(payload.cnf, ['jkt']) ||
    payload.cnf.jkt !== binding.thumbprint ||
    typeof payload.jti !== 'string' ||
    !uuid.test(payload.jti) ||
    typeof payload.iat !== 'number' ||
    !Number.isSafeInteger(payload.iat) ||
    payload.iat < 0 ||
    payload.iat > input.nowSeconds ||
    typeof payload.exp !== 'number' ||
    !Number.isSafeInteger(payload.exp) ||
    payload.exp - payload.iat !== input.ttlSeconds
  )
    throw new Error('Invalid credential claims')
  return {
    agentId: input.agentId,
    farmId: input.farmId,
    fingerprint: binding.fingerprint,
    thumbprint: binding.thumbprint,
    jti: payload.jti,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
  }
}
