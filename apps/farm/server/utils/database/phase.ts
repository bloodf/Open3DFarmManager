/** Dependency-free so middleware and WebSocket hooks can import it cheaply. */
export type DatabasePhase = 'disabled' | 'starting' | 'ready' | 'failed'

let phase: DatabasePhase = 'disabled'
export const databasePhase = (): DatabasePhase => phase
export const setDatabasePhase = (next: DatabasePhase): void => {
  phase = next
}
export const databaseServing = (): boolean =>
  phase === 'disabled' || phase === 'ready'

const EXEMPT = new Set(['/healthz', '/readyz'])
/** Only liveness and readiness are reachable while the schema is unverified. */
export function databaseGateBlocks(pathname: string): boolean {
  return !databaseServing() && !EXEMPT.has(pathname)
}
