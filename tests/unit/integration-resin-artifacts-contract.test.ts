import { describe, expect, it } from 'vitest'
import { preflightResinArtifactReplay } from '../../packages/shared/src/print-file/resin-replay.ts'
import { validateResinArtifactContract } from '../../packages/shared/src/print-file/resin-artifacts.ts'
import {
  acceptedArtifact,
  rejectedArtifact,
} from '../fixtures/resin-artifacts/contracts.ts'

describe('resin artifact declarations', () => {
  it('resolves a compatible printer profile and the single executable plate', () => {
    const { filename, profile } = acceptedArtifact
    expect(validateResinArtifactContract(filename, profile)).toMatchObject({
      ok: true,
      format: { extension: '.pm7m', evidence: 'spec-derived' },
      profile,
      plate: 1,
    })
  })

  it('refuses a file for a different model in the same printer family', () => {
    const { filename, profile, plate } = rejectedArtifact
    expect(validateResinArtifactContract(filename, profile, plate)).toEqual({
      ok: false,
      reason: 'profile-mismatch',
    })
  })

  it('refuses a plate outside the single executable plate', () => {
    const { filename, profile } = acceptedArtifact
    expect(validateResinArtifactContract(filename, profile, 2)).toEqual({
      ok: false,
      reason: 'plate-mismatch',
    })
  })

  it('refuses an unpublished extension in a known family', () => {
    expect(
      validateResinArtifactContract('test.pm99', acceptedArtifact.profile),
    ).toEqual({ ok: false, reason: 'unsupported-format' })
  })
})

describe('resin replay preflight', () => {
  const version = {
    id: '0da6cc86-88d9-474c-870e-2752c6534b77',
    sha256: 'a'.repeat(64),
    ...acceptedArtifact,
  }
  const replay = {
    version,
    requestedVersionId: version.id,
    assignmentId: 'test-assignment',
    targetProfile: version.profile,
  } as const
  const capability = {
    assignmentId: replay.assignmentId,
    profile: version.profile,
    extensions: ['.pm7m'],
  } as const

  it('refuses replay and retains the version when no qualified driver is connected', () => {
    expect(
      preflightResinArtifactReplay({ ...replay, capabilities: [] }),
    ).toEqual({
      status: 'unsupported',
      reason: 'resin-artifact-dispatch-unavailable',
      libraryVersionId: version.id,
      sha256: version.sha256,
    })
  })

  it('accepts an exact capability advertisement from a fake driver', () => {
    expect(
      preflightResinArtifactReplay({ ...replay, capabilities: [capability] }),
    ).toMatchObject({
      status: 'eligible',
      libraryVersionId: version.id,
      extension: '.pm7m',
      plate: 1,
    })
  })

  it('requires the advertised capability to belong to the target assignment', () => {
    expect(
      preflightResinArtifactReplay({
        ...replay,
        capabilities: [{ ...capability, assignmentId: 'other-assignment' }],
      }),
    ).toMatchObject({ status: 'unsupported' })
  })

  it('refuses a different immutable version', () => {
    expect(
      preflightResinArtifactReplay({
        ...replay,
        requestedVersionId: '798f2649-6c66-45cf-940f-aeeabea15573',
        capabilities: [capability],
      }),
    ).toEqual({ status: 'rejected', reason: 'version-mismatch' })
  })
})
