// Parses a loopback port override: empty or unset uses the default; anything
// else must be an integer from 1 to 65535.
export function e2ePort(name: string, fallback: number): string {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return String(fallback)
  const port = Number(raw)
  if (!/^\d+$/.test(raw) || port < 1 || port > 65535)
    throw new Error(`${name} must be an integer from 1 to 65535, got "${raw}"`)
  return String(port)
}
