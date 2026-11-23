import {
  validateResinArtifactContract,
  type ResinArtifactExtension,
  type ResinPrinterProfile,
} from '../../../../packages/shared/src/print-file/resin-artifacts.ts'

export interface ResinArtifactVersion {
  id: string
  sha256: string
  filename: string
  profile: string
}

/** A qualified artifact-dispatch advertisement for the target assignment. */
export interface ResinArtifactDispatchCapability {
  assignmentId: string
  profile: ResinPrinterProfile
  extensions: readonly ResinArtifactExtension[]
}

export function preflightResinArtifactReplay(input: {
  version: ResinArtifactVersion
  requestedVersionId: string
  plate?: number
  assignmentId: string
  targetProfile: string | null
  capabilities: readonly ResinArtifactDispatchCapability[]
}) {
  const { version, assignmentId, targetProfile } = input
  const receipt = { libraryVersionId: version.id, sha256: version.sha256 }
  if (version.id !== input.requestedVersionId)
    return { status: 'rejected', reason: 'version-mismatch' } as const

  const artifact = validateResinArtifactContract(
    version.filename,
    version.profile,
    input.plate,
  )
  if (!artifact.ok)
    return { ...receipt, status: 'rejected', reason: artifact.reason } as const
  if (targetProfile !== null && artifact.profile !== targetProfile)
    return {
      ...receipt,
      status: 'rejected',
      reason: 'profile-mismatch',
    } as const

  const extension = artifact.format.extension
  const qualified = input.capabilities.some(
    (capability) =>
      capability.assignmentId === assignmentId &&
      capability.profile === targetProfile &&
      capability.extensions.includes(extension),
  )
  if (!qualified)
    return {
      ...receipt,
      status: 'unsupported',
      reason: 'resin-artifact-dispatch-unavailable',
    } as const

  return {
    ...receipt,
    status: 'eligible',
    extension,
    plate: artifact.plate,
  } as const
}
