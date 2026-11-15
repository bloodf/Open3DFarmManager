import type { PauseCapabilityHandle } from '../auth/pause-capability.ts'

/**
 * The browser marks its control session ready as soon as it has sent the
 * admission proof, and may send its first file request right behind it, while
 * the relay is still verifying that proof. A file request therefore waits
 * this long for the admitted capability before it is refused. The wait grants
 * nothing: without an admitted capability the request is still refused.
 */
export const FILE_ADMISSION_GRACE_MS = 2000

export async function awaitAdmittedHandle(
  read: () => PauseCapabilityHandle | undefined,
  signal: AbortSignal,
  graceMs: number = FILE_ADMISSION_GRACE_MS,
): Promise<PauseCapabilityHandle | undefined> {
  const deadline = performance.now() + graceMs
  for (;;) {
    const handle = read()
    if (handle || signal.aborted || performance.now() >= deadline) return handle
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
}
