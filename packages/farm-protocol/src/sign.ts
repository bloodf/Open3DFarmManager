import { UnsignedCommand, SignedCommand } from './command.ts'
import { canonicalize } from './canonical.ts'
import { base64url } from './encoding.ts'

export type CommandInput = Pick<
  UnsignedCommand,
  | 'farm_id'
  | 'agent_id'
  | 'printer_id'
  | 'user_id'
  | 'key_id'
  | 'session_id'
  | 'action'
>

export async function createBrowserKey(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
}

export async function signCommand(
  input: CommandInput,
  privateKey: CryptoKey,
  now = Date.now(),
): Promise<SignedCommand> {
  const algorithm = privateKey.algorithm as EcKeyAlgorithm
  if (
    privateKey.type !== 'private' ||
    privateKey.extractable ||
    algorithm.name !== 'ECDSA' ||
    algorithm.namedCurve !== 'P-256'
  )
    throw new Error('Expected a nonextractable P-256 private key')
  const command = UnsignedCommand.parse({
    ...input,
    v: 1,
    cmd_id: crypto.randomUUID(),
    args: {},
    issued_at: now,
    expires_at: now + 60_000,
    nonce: base64url(crypto.getRandomValues(new Uint8Array(16))),
  })
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(canonicalize(command)),
  )
  return SignedCommand.parse({
    ...command,
    sig: base64url(new Uint8Array(signature)),
  })
}
