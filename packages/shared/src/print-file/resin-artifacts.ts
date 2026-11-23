const elegooProfiles = [
  'elegoo:saturn-4-ultra',
  'elegoo:saturn-4-ultra-16k',
  'elegoo:mars-5-ultra',
] as const

const elegooSource =
  'https://wiki.elegoo.com/en/troubleshooting/lcd-printer/abnormal-noise-during-printing'

export const resinArtifactFormats = [
  {
    extension: '.ctb',
    family: 'elegoo-sdcp',
    profiles: elegooProfiles,
    source: elegooSource,
    evidence: 'spec-derived',
  },
  {
    extension: '.goo',
    family: 'elegoo-sdcp',
    profiles: elegooProfiles,
    source: elegooSource,
    evidence: 'spec-derived',
  },
  {
    extension: '.pm7m',
    family: 'anycubic-photon',
    profiles: ['anycubic:photon-mono-m7-max'],
    source:
      'https://wiki.anycubic.com/en/resin-3d-printer/anycubic-photon-mono-m7-max/usb-recognition-lssue',
    evidence: 'spec-derived',
  },
  {
    extension: '.pp1m',
    family: 'anycubic-photon',
    profiles: ['anycubic:photon-p1-max'],
    source:
      'https://wiki.anycubic.com/en/resin-3d-printer/anycubic-photon-p1-max',
    evidence: 'spec-derived',
  },
  {
    extension: '.pwsz',
    family: 'anycubic-photon',
    profiles: ['anycubic:photon-mono-m7-pro'],
    source:
      'https://wiki.anycubic.com/fr/resin-3d-printer/photon-mono-m7-pro/faq',
    evidence: 'spec-derived',
  },
  {
    extension: '.form',
    family: 'formlabs-preform',
    profiles: ['formlabs:form-4', 'formlabs:form-4l'],
    source: 'https://formlabs.com/support/PreForm-Release-Notes/',
    evidence: 'spec-derived',
  },
] as const

export type ResinArtifactFormat = (typeof resinArtifactFormats)[number]
export type ResinArtifactExtension = ResinArtifactFormat['extension']
export type ResinPrinterProfile = ResinArtifactFormat['profiles'][number]

export type ResinArtifactContractResult =
  | {
      ok: true
      format: ResinArtifactFormat
      profile: ResinPrinterProfile
      plate: 1
    }
  | {
      ok: false
      reason: 'unsupported-format' | 'profile-mismatch' | 'plate-mismatch'
    }

/** Validates the declared metadata. The qualified driver must verify the payload. */
export function validateResinArtifactContract(
  filename: string,
  profile: string,
  plate: number = 1,
): ResinArtifactContractResult {
  const format = resinArtifactFormatFor(filename)
  if (!format) return { ok: false, reason: 'unsupported-format' }
  const compatibleProfile = format.profiles.find(
    (candidate) => candidate === profile,
  )
  if (!compatibleProfile) return { ok: false, reason: 'profile-mismatch' }
  if (plate !== 1) return { ok: false, reason: 'plate-mismatch' }
  return { ok: true, format, profile: compatibleProfile, plate }
}

export function resinArtifactFormatFor(filename: string) {
  const extensionOffset = filename.lastIndexOf('.')
  const extension =
    extensionOffset > 0 ? filename.slice(extensionOffset).toLowerCase() : ''
  return resinArtifactFormats.find((entry) => entry.extension === extension)
}
