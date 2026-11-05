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

export type FixtureStream =
  | 'nitro.stdout'
  | 'nitro.stderr'
  | 'acceptance.stdout'
  | 'acceptance.stderr'
export function createFixtureCapture() {
  const logs = new Map<FixtureStream, string>()
  return {
    append(source: FixtureStream, chunk: Buffer) {
      const previous = logs.get(source) ?? ''
      if (previous.length < 16384)
        logs.set(
          source,
          previous + chunk.toString('utf8').slice(0, 16384 - previous.length),
        )
    },
    entries() {
      return [...logs.entries()]
    },
  }
}
