type Session = {
  start(): Promise<void>
  close(reason: string): void
  dispose(timeoutMs: number): Promise<void>
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    if (signal.aborted) done()
  })
}

/** One fresh session at a time. Admission is not termination or lease renewal. */
export async function runSignallingLifecycle(input: {
  signal: AbortSignal
  credentialExpiresAt: number
  retryMinMs: number
  retryMaxMs: number
  /**
   * Reset retry pressure after 30 seconds of admitted uptime, or when a
   * single-use session reports it served the peer it was opened for.
   */
  now?: () => number
  monotonic?: () => number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  onReconnect?: () => void
  createSession(
    onTerminal: () => void,
    onAdmitted: () => void,
    onServed: () => void,
  ): Session
}): Promise<void> {
  const now = input.now ?? Date.now
  const monotonic = input.monotonic ?? (() => performance.now())
  const sleep = input.sleep ?? wait
  let backoff = input.retryMinMs
  let expired = false
  const deadlineMono =
    monotonic() + Math.max(0, input.credentialExpiresAt - now())
  const remaining = () =>
    Math.min(input.credentialExpiresAt - now(), deadlineMono - monotonic())
  while (!expired && !input.signal.aborted && remaining() > 0) {
    let finish = () => {}
    const terminal = new Promise<void>((resolve) => {
      finish = resolve
    })
    let session: Session | undefined
    let ended = false
    let admittedAt: number | undefined
    let served = false
    let closeFailure: { error: unknown } | undefined
    const endedSession = () => {
      if (
        !ended &&
        admittedAt !== undefined &&
        (served || monotonic() - admittedAt >= 30_000)
      )
        backoff = input.retryMinMs
      ended = true
      finish()
    }
    const stop = () => {
      try {
        session?.close('runtime-stopped')
      } catch (error) {
        closeFailure ??= { error }
      } finally {
        endedSession()
      }
    }
    const timer = setTimeout(
      () => {
        // Timer rounding can precede the sampled clock deadline. Once expiry
        // closes the session, a positive remainder must never restart it.
        expired = true
        stop()
      },
      Math.max(0, remaining()),
    )
    input.signal.addEventListener('abort', stop, { once: true })
    try {
      session = input.createSession(
        endedSession,
        () => {
          // Measure the first admission only; late callbacks cannot reset pressure.
          if (!ended && admittedAt === undefined) admittedAt = monotonic()
        },
        () => {
          // Ending after its one job is done is not a failure. Only an
          // admitted session can serve, and a late report changes nothing.
          if (!ended && admittedAt !== undefined) served = true
        },
      )
      if (ended || input.signal.aborted || remaining() <= 0) stop()
      else {
        // start resolves on admission. Keep the slot until terminal AND disposal.
        void session.start().catch(stop)
      }
      await terminal
    } finally {
      clearTimeout(timer)
      input.signal.removeEventListener('abort', stop)
      if (session) {
        try {
          session.close('runtime-terminal')
        } finally {
          // Failure deliberately stops retries rather than overlapping resources.
          await session.dispose(5000)
        }
      }
    }
    if (closeFailure) throw closeFailure.error
    if (expired) return
    await sleep(Math.min(backoff, Math.max(0, remaining())), input.signal)
    if (!input.signal.aborted && remaining() > 0) input.onReconnect?.()
    backoff = Math.min(input.retryMaxMs, backoff * 2)
  }
}
