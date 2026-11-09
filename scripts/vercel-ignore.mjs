import { execFileSync } from 'node:child_process'

// Vercel uses 0 to cancel and 1 to build. Unknown history holds deployment.
function decide() {
  const env = process.env
  if (
    env.VERCEL_GIT_COMMIT_REF !== 'main' ||
    env.VERCEL_ENV !== 'production' ||
    env.VERCEL_GIT_PULL_REQUEST_ID
  ) {
    return [0, 'SKIP: only integrated main production changes may build']
  }

  const previous = env.VERCEL_GIT_PREVIOUS_SHA || ''
  const current = env.VERCEL_GIT_COMMIT_SHA || ''
  if (![previous, current].every((sha) => /^[a-f0-9]{40}$/.test(sha))) {
    return [0, 'HOLD: missing or invalid deployment SHA; review history manually']
  }

  const git = (...args) =>
    execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    const root = git('rev-parse', '--show-toplevel').trim()
    const atRoot = (...args) => git('-C', root, ...args)
    if (atRoot('rev-parse', 'HEAD').trim() !== current) {
      return [0, 'HOLD: checkout does not match deployment SHA']
    }
    atRoot('merge-base', '--is-ancestor', previous, current)
    // Compare deployed trees, not HEAD^ or a merge base; squash and multi-commit merges work.
    const paths = atRoot('diff', '--name-only', '--no-renames', '-z', previous, current)
      .split('\0')
      .filter(Boolean)
    const relevant = paths.some(
      (path) =>
        !/^(?:docs|tests|\.github|\.codegraph)\//.test(path) &&
        !/^(?:README\.md|AGENTS\.md|\.codegraph-version|renovate\.json)$/.test(path) &&
        path !== 'scripts/test-vercel-ignore.mjs',
    )
    return relevant
      ? [1, 'BUILD: main changes include site, workspace, or build inputs']
      : [0, 'SKIP: no site or build input changes since last successful deployment']
  } catch {
    return [0, 'HOLD: unavailable or non-ancestor history; review history manually']
  }
}

const [code, message] = decide()
console.log(message)
process.exitCode = code
