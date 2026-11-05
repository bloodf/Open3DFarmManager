export function base64url(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}
export function decodeBase64url(
  value: string,
  expectedBytes: number,
): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url')
  const binary = atob(
    value.replaceAll('-', '+').replaceAll('_', '/') +
      '='.repeat((4 - (value.length % 4)) % 4),
  )
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  if (bytes.length !== expectedBytes || base64url(bytes) !== value)
    throw new Error('Noncanonical base64url')
  return bytes
}
