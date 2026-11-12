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
   * `onAdmitted` reports that the server admitted this session's credential
   * proof. The next reconnect then waits only retryMinMs, so a long-lived
   * Connector keeps its reconnect gap below the offline authority lifetime.
   */
  createSession(onTerminal: () => void, onAdmitted: () => void): Session
}): Promise<void> {
  let backoff = input.retryMinMs
  let expired = false
  const deadlineMono =
    performance.now() + Math.max(0, input.credentialExpiresAt - Date.now())
  const remaining = () =>
    Math.min(
      input.credentialExpiresAt - Date.now(),
      deadlineMono - performance.now(),
    )
  while (!expired && !input.signal.aborted && remaining() > 0) {
    let finish = () => {}
    const terminal = new Promise<void>((resolve) => {
      finish = resolve
    })
    let session: Session | undefined
    let ended = false
    let closeFailure: { error: unknown } | undefined
    const endedSession = () => {
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
      session = input.createSession(endedSession, () => {
        // A late callback from an ended session never resets backoff.
        if (!ended) backoff = input.retryMinMs
      })
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
    await wait(Math.min(backoff, Math.max(0, remaining())), input.signal)
    backoff = Math.min(input.retryMaxMs, backoff * 2)
  }
}
