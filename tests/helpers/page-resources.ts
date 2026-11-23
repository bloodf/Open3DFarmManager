/** Closes the browser context and the mock listener even when one of them fails. */
export async function disposePageResources(resources: {
  context?: { close: () => Promise<unknown> } | undefined
  server?: { close: () => Promise<unknown> } | undefined
}): Promise<void> {
  const errors: unknown[] = []
  if (resources.context)
    await resources.context.close().catch((error: unknown) => {
      errors.push(error)
    })
  if (resources.server)
    await resources.server.close().catch((error: unknown) => {
      errors.push(error)
    })
  if (errors.length > 0) {
    const error = errors[0]
    throw error instanceof Error ? error : new Error(String(error))
  }
}
