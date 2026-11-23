/** Tracks the newest request in a UI scope so older responses can be ignored. */
export function createLatestRequestGuard() {
  let latest = 0

  return {
    next() {
      latest += 1
      return latest
    },
    isCurrent(request: number) {
      return request === latest
    },
    invalidate() {
      latest += 1
    },
  }
}
