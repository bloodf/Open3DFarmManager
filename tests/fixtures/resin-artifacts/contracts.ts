export const evidence = 'spec-derived, not captured'

export const acceptedArtifact = {
  filename: 'test.PM7M',
  profile: 'anycubic:photon-mono-m7-max',
  plate: 1,
} as const

export const rejectedArtifact = {
  ...acceptedArtifact,
  profile: 'anycubic:photon-mono-m7-pro',
} as const
