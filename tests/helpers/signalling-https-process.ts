import { once } from 'node:events'
import type { ChildProcess } from 'node:child_process'

/** Install immediately after spawn; close means inherited output streams have drained. */
export function observeFixtureClose(child: ChildProcess) {
  child.on('error', () => {})
  const closed = once(child, 'close')
  // Keep an early spawn error observable without an unhandled rejection.
  void closed.catch(() => {})
  return closed
}

export async function waitFixtureClose(
  closed: Promise<unknown[]>,
  timeoutMs: number,
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Fixture stream drain timed out')),
          timeoutMs,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
