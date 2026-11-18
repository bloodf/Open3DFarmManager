// SPDX-License-Identifier: MIT
export const MIN_SUPPORTED_NODE_VERSION = '22.18.0' as const
const MIN_MAJOR = 22
const MIN_MINOR = 18

export function isSupportedNodeVersion(
  versionString: string = process.version,
): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(versionString)
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  if (major === 22) return minor >= MIN_MINOR
  return major === 23 || major === 24
}

export function assertSupportedNodeRuntime(
  versions: { node?: string; bun?: string } = process.versions,
): void {
  if (
    versions.bun ||
    !versions.node ||
    !isSupportedNodeVersion(versions.node)
  ) {
    throw new Error(`Node >=${MIN_SUPPORTED_NODE_VERSION} <25 is required`)
  }
}
