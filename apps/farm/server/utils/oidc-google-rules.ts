/** Invitation data comes from the locked database row, never from the browser. */
export function googleInviteAllowed(input: {
  verifiedEmail: string
  boundEmail: unknown
  role: unknown
  mode: unknown
}): boolean {
  return (
    (input.role === 'viewer' || input.role === 'operator') &&
    (input.mode === 'invite-only' || input.mode === 'allowed-domains') &&
    typeof input.boundEmail === 'string' &&
    input.boundEmail === input.verifiedEmail
  )
}
