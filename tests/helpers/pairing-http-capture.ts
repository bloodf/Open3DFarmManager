/** Fail closed if browser response capture does not settle within its budget. */
export async function waitForBrowserCapture(
  reads: Promise<void>[],
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.all(reads),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Browser response capture timed out')),
          timeoutMs,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
