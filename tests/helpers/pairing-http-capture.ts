/** Fail closed if browser response capture does not settle within its budget. */
export async function waitForBrowserCapture(
  reads: Promise<void>[],
  timeoutMs: number,
  timeoutMessage = 'Browser response capture timed out',
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.all(reads),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
