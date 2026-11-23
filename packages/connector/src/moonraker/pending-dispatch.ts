/**
 * Whether OpenFarm has an outstanding start on a printer. A terminal job seen
 * on the first snapshot is reported as `lastJob` only then; any other job that
 * ended unwatched is left to the history import.
 */
export type PendingDispatchResolver = (printerKey: string) => boolean

const resolvers = new Set<PendingDispatchResolver>()

/** Registers a resolver until the returned function is called. */
export function registerMoonrakerPendingDispatch(
  resolver: PendingDispatchResolver,
): () => void {
  resolvers.add(resolver)
  return () => {
    resolvers.delete(resolver)
  }
}

export function hasMoonrakerPendingDispatch(printerKey: string): boolean {
  for (const resolver of resolvers) {
    try {
      if (resolver(printerKey)) return true
    } catch {
      // An unreadable marker never claims a dispatch.
    }
  }
  return false
}
