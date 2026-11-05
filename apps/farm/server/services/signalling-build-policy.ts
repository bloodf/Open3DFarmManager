/** Build opt-in is distinct from a runtime environment flag. This policy does not
 * authorize a peer; it only selects whether the pinned native adapter may exist. */
export function signallingBuildEnabled(value: unknown): boolean {
  if (value === undefined) return false
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid signalling build configuration')
  if (!('enabled' in value) || value.enabled === false) return false
  if (value.enabled !== true)
    throw new Error('Signalling build opt-in must be a boolean')
  return true
}

export function assertSignallingRuntimeBoundary(input: {
  runtimeEnabled: boolean
  buildEnabled: boolean
  nativeWebSocketCompiled: boolean
  preset: string
}): void {
  if (!input.runtimeEnabled) return
  if (
    !input.buildEnabled ||
    !input.nativeWebSocketCompiled ||
    input.preset !== 'node-server'
  )
    throw new Error('Signalling requires its bounded node-server build opt-in')
}
