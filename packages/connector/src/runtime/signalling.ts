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
  createSession(onTerminal: () => void): Session
}): Promise<void> {
  let backoff = input.retryMinMs
  const deadlineMono =
    performance.now() + Math.max(0, input.credentialExpiresAt - Date.now())
  const remaining = () =>
    Math.min(
      input.credentialExpiresAt - Date.now(),
      deadlineMono - performance.now(),
    )
  while (!input.signal.aborted && remaining() > 0) {
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
    const timer = setTimeout(stop, Math.max(0, remaining()))
    input.signal.addEventListener('abort', stop, { once: true })
    try {
      session = input.createSession(endedSession)
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
    await wait(Math.min(backoff, Math.max(0, remaining())), input.signal)
    backoff = Math.min(input.retryMaxMs, backoff * 2)
  }
}
