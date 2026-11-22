export function jobIdOf(json: unknown): string | undefined {
  if (!json || typeof json !== 'object' || !('id' in json)) return undefined
  return typeof json.id === 'string' ? json.id : undefined
}

/** The second response is the original job only when exactly one row was stored. */
export function replayReusedJob(input: {
  firstStatus: number
  firstId: string | undefined
  secondId: string | undefined
  persisted: number
}): void {
  if (input.firstStatus !== 202)
    throw new Error('replay first response was not accepted')
  if (!input.firstId || input.firstId !== input.secondId)
    throw new Error('replay returned a different job')
  if (input.persisted !== 1)
    throw new Error('replay persisted more than one job')
}
