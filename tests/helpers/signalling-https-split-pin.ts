import { execFileSync } from 'node:child_process'

export const ARTIFACT_HEAD = '869b46e396bbcf93716fe8901bb956f5a4e379f7'
const allowed = new Set([
  'scripts/test-signalling-https.ts',
  'tests/helpers/signalling-https-acceptance.ts',
  'tests/helpers/signalling-https-process.ts',
  'tests/node/signalling-https-process.test.ts',
  'tests/node/signalling-https-proxy.test.ts',
  'tests/helpers/signalling-https-split-pin.ts',
  'tests/node/signalling-https-split-pin.test.ts',
])
/** Every non-fixture path, including additions and removals, must match the base tree. */
export function assertSplitTrees(
  checkout: string,
  base: string,
  expectedHead: string,
) {
  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd: checkout,
      timeout: 10000,
      maxBuffer: 4 * 1024 * 1024,
    }).toString('utf8')
  if (
    !/^[a-f0-9]{40}$/.test(expectedHead) ||
    git(['rev-parse', 'HEAD']).trim() !== expectedHead ||
    git(['status', '--porcelain=v1', '--untracked-files=all']).length
  )
    throw new Error('Split fixture source is dirty or head changed')
  const ignored = git([
    'ls-files',
    '-o',
    '-i',
    '--exclude-standard',
    '-z',
    '--',
    'apps/farm/server',
    'apps/farm/modules',
    'packages/connector/src',
    'packages/farm-protocol/src',
    'scripts',
    'tests/helpers',
  ])
    .split('\0')
    .filter(Boolean)
  if (ignored.some((path) => /\.(?:[cm]?[jt]sx?|json|vue)$/.test(path)))
    throw new Error('Ignored source input in fixture import roots')
  const raw = git([
    'diff',
    '--name-status',
    '--no-renames',
    '-z',
    base,
    expectedHead,
    '--',
  ])
    .split('\0')
    .filter(Boolean)
  if (!raw.length || raw.length % 2 !== 0)
    throw new Error('Invalid split tree inventory')
  for (let i = 0; i < raw.length; i += 2) {
    if (!['A', 'M'].includes(raw[i]!) || !allowed.has(raw[i + 1]!))
      throw new Error('Split fixture contains unsupported changes')
  }
}

export function assertArtifactSeal(
  actual: { configSha256: string; outputSha256: string; outputFiles: number },
  expected: { configSha256: string; outputSha256: string; outputFiles: number },
) {
  if (
    actual.configSha256 !== expected.configSha256 ||
    actual.outputSha256 !== expected.outputSha256 ||
    actual.outputFiles !== expected.outputFiles
  )
    throw new Error('Built output or config manifest mismatch')
}
