/** Returns undefined when versions cannot be ordered safely. */
export function firmwareUpdateAvailable(
  current?: string,
  latest?: string,
): boolean | undefined {
  if (!current || !latest) return undefined
  if (current === latest) return false
  const pattern = /^v?(\d+(?:\.\d+)*)$/i
  const a = pattern.exec(current)?.[1]?.split('.')
  const b = pattern.exec(latest)?.[1]?.split('.')
  if (!a || !b) return undefined
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = BigInt(a[i] ?? '0')
    const right = BigInt(b[i] ?? '0')
    if (left !== right) return right > left
  }
  return false
}
