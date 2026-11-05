import { z } from 'zod'
import { canonicalize } from './canonical.ts'
import { parseBoundedJson } from './json.ts'

const id = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase(), {
    message: 'Use lowercase UUIDs',
  })
const fields = {
  v: z.literal(1),
  cmd_id: id,
  farm_id: id,
  agent_id: id,
  printer_id: id,
  user_id: id,
  key_id: id,
  session_id: id,
  action: z.enum(['pause', 'resume', 'cancel', 'emergency_stop']),
  args: z.strictObject({}),
  issued_at: z.number().int().nonnegative(),
  expires_at: z.number().int().nonnegative(),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{21}[AQgw]$/),
}
const lifetime = (command: { issued_at: number; expires_at: number }) =>
  command.expires_at > command.issued_at &&
  command.expires_at - command.issued_at <= 60_000
const lifetimeError = {
  message: 'Command lifetime must be between 1 and 60000 milliseconds',
}
export const UnsignedCommand = z
  .strictObject(fields)
  .refine(lifetime, lifetimeError)
export const SignedCommand = z
  .strictObject({
    ...fields,
    sig: z.string().regex(/^[A-Za-z0-9_-]{85}[AQgw]$/),
  })
  .refine(lifetime, lifetimeError)
export type UnsignedCommand = z.infer<typeof UnsignedCommand>
export type SignedCommand = z.infer<typeof SignedCommand>

export function encodeCommand(command: SignedCommand): string {
  return canonicalize(SignedCommand.parse(command))
}

// Canonical wire encoding rejects duplicate keys and ambiguous JSON representations.
export function decodeCommand(wire: string): SignedCommand {
  if (new TextEncoder().encode(wire).length > 8192)
    throw new Error('Command frame exceeds 8192 bytes')
  const command = SignedCommand.parse(
    parseBoundedJson(wire, {
      maxBytes: 8192,
      maxDepth: 6,
      maxValues: 64,
      maxStringChars: 1024,
    }),
  )
  if (encodeCommand(command) !== wire)
    throw new Error('Command frame is not canonical JSON')
  return command
}
