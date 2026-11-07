import {
  requestPasswordReset,
  type PasswordResetDelivery,
  type PasswordResetStore,
} from './password-reset.ts'

/** One application-owned queue. No account lookup occurs during admission. */
export class PasswordResetQueue {
  private readonly pending: string[] = []
  private readonly active = new Set<Promise<void>>()
  private scheduled: ReturnType<typeof setImmediate> | undefined
  private readonly abort = new AbortController()
  private closed = false
  private failures = 0
  private readonly store: PasswordResetStore
  private readonly delivery: PasswordResetDelivery
  constructor(store: PasswordResetStore, delivery: PasswordResetDelivery) {
    this.store = store
    this.delivery = delivery
  }
  get failureCount(): number {
    return this.failures
  }
  enqueue(username: string): boolean {
    if (this.closed || this.pending.length + this.active.size >= 64)
      return false
    this.pending.push(username)
    this.schedule()
    return true
  }
  private schedule(): void {
    if (
      this.closed ||
      this.scheduled ||
      !this.pending.length ||
      this.active.size >= 2
    )
      return
    // A later event-loop turn starts identity-dependent work, after HTTP admission returns.
    this.scheduled = setImmediate(() => {
      this.scheduled = undefined
      while (!this.closed && this.pending.length && this.active.size < 2) {
        const username = this.pending.shift()
        if (username === undefined) break
        const job = requestPasswordReset(
          username,
          this.store,
          this.delivery,
          this.abort.signal,
        )
          .catch(() => {
            this.failures++
          })
          .finally(() => {
            this.active.delete(job)
            this.schedule()
          })
        this.active.add(job)
      }
    })
  }
  /** Stop admission, discard waiting names, abort delivery and drain active jobs.
   * Adapters must honor AbortSignal. A non-cooperative adapter retains its slot;
   * it is never detached or replaced with another unbounded background operation.
   */
  async close(): Promise<void> {
    this.closed = true
    if (this.scheduled) clearImmediate(this.scheduled)
    this.scheduled = undefined
    this.pending.length = 0
    this.abort.abort()
    await Promise.all(this.active)
  }
}
