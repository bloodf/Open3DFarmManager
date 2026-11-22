/** Runs `release` for every resource registered before a failure or return. */
export async function withOwnedCleanup<T>(
  run: (own: (release: () => Promise<void>) => void) => Promise<T>,
): Promise<T> {
  const releases: Array<() => Promise<void>> = []
  const finish = async () => {
    const pending = releases.splice(0).reverse()
    const failures: unknown[] = []
    for (const release of pending)
      await release().catch((error: unknown) => {
        failures.push(error)
      })
    return failures
  }
  try {
    const value = await run((release) => {
      releases.push(release)
    })
    const failures = await finish()
    if (failures.length > 0) throw asError(failures[0])
    return value
  } catch (error) {
    const failures = await finish()
    if (failures.length > 0)
      throw new AggregateError(
        [error, ...failures],
        error instanceof Error ? error.message : 'owned cleanup failed',
      )
    throw error
  }
}

/**
 * Registers resources as they are acquired. A thrown setup releases them;
 * a returned value leaves them with the caller.
 */
export async function releaseOnFailure<T>(
  run: (hold: (release: () => Promise<void>) => void) => Promise<T>,
): Promise<T> {
  const releases: Array<() => Promise<void>> = []
  try {
    return await run((release) => {
      releases.push(release)
    })
  } catch (error) {
    const pending = releases.splice(0).reverse()
    const failures: unknown[] = []
    for (const release of pending)
      await release().catch((failure: unknown) => {
        failures.push(failure)
      })
    if (failures.length > 0)
      throw new AggregateError(
        [error, ...failures],
        error instanceof Error ? error.message : 'startup cleanup failed',
      )
    throw error
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
