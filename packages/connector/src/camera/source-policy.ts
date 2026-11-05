export type CameraScope = Readonly<{
  farmId: string
  agentId: string
  printerId: string
}>

export type CameraConfiguration = Readonly<{
  cameraId: string
  scope: CameraScope
  sourceHandle: string
}>

export function sameCameraScope(a: CameraScope, b: CameraScope): boolean {
  return (
    a.farmId === b.farmId &&
    a.agentId === b.agentId &&
    a.printerId === b.printerId
  )
}

export function createLocalCameraRegistry(
  configurations: readonly CameraConfiguration[],
) {
  if (configurations.length > 256)
    throw new Error('Invalid camera configuration')
  const opaqueId = (value: string) => /^[-A-Za-z0-9_]{1,128}$/.test(value)
  const entries = configurations.map(({ cameraId, scope, sourceHandle }) => ({
    cameraId,
    scope: { ...scope },
    sourceHandle,
  }))
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (
      !entry ||
      !opaqueId(entry.cameraId) ||
      !opaqueId(entry.sourceHandle) ||
      !opaqueId(entry.scope.farmId) ||
      !opaqueId(entry.scope.agentId) ||
      !opaqueId(entry.scope.printerId) ||
      entries
        .slice(0, i)
        .some(
          (other) =>
            other.cameraId === entry.cameraId &&
            sameCameraScope(other.scope, entry.scope),
        )
    ) {
      throw new Error('Invalid camera configuration')
    }
  }
  return Object.freeze({
    resolve({
      cameraId,
      scope,
    }: {
      cameraId: string
      scope: CameraScope
    }): string | undefined {
      return entries.find(
        (entry) =>
          entry.cameraId === cameraId && sameCameraScope(entry.scope, scope),
      )?.sourceHandle
    },
  })
}

export type LocalCameraRegistry = ReturnType<typeof createLocalCameraRegistry>
