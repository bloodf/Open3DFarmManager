import { z } from 'zod'

const id = z.string().uuid()
const signature = z.string().regex(/^[A-Za-z0-9_-]{86}$/)
const emptyArgs = z.strictObject({})
const envelope = {
  v: z.literal(1),
  cmd_id: id,
  farm_id: id,
  agent_id: id,
  printer_id: id,
  user_id: id,
  key_id: id,
  issued_at: z.number().int().nonnegative(),
  expires_at: z.number().int().nonnegative(),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  sig: signature,
}
// This phase only exposes stop/pause controls. Execution still requires local verification.
export const SignedCommand = z
  .strictObject({
    ...envelope,
    action: z.enum(['pause', 'resume', 'cancel', 'emergency_stop']),
    args: emptyArgs,
  })
  .refine(
    (c) => c.expires_at > c.issued_at && c.expires_at - c.issued_at <= 60_000,
    { message: 'Command lifetime must be between 1 and 60000 milliseconds' },
  )
export type SignedCommand = z.infer<typeof SignedCommand>
