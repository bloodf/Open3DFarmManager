export function snapshotImportRequest<T extends Record<string, unknown>>(
  request: T,
): T {
  return structuredClone(request)
}

export function sameSlots(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length && left.every((slot, i) => slot === right[i])
  )
}

export function safeReadStored(
  storage: Pick<Storage, 'getItem'> | null | undefined,
  key: string,
): string | null {
  try {
    return storage?.getItem(key) ?? null
  } catch {
    return null
  }
}

export function safeWriteStored(
  storage: Pick<Storage, 'setItem'> | null | undefined,
  key: string,
  value: string,
): void {
  try {
    storage?.setItem(key, value)
  } catch {
    // Storage may be unavailable or full; assignments still work in memory.
  }
}
