// Evidence-directory guard shared by verify.mjs and its regression test.
// Screenshots and report.json must never land inside the repository, even when
// the configured path reaches it through a symlink (as the final component or
// in any ancestor). Nothing is created or deleted before the check passes.
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  realpath,
  rm,
} from 'node:fs/promises'
import path from 'node:path'
import { isInside } from './files.mjs'

const MAX_LINK_DEPTH = 40
const EVIDENCE_FILE = /\.(png|json)$/

/**
 * Where `target` really points, following every symlink (ancestors and the
 * final component, dangling links included) even when part of the path does
 * not exist yet. Pure reads; creates nothing.
 */
export async function resolveReal(target, depth = 0) {
  if (depth > MAX_LINK_DEPTH) {
    throw new Error(`Too many symbolic links while resolving ${target}.`)
  }
  const absolute = path.resolve(target)
  try {
    return await realpath(absolute)
  } catch (error) {
    // ENOENT: missing tail, or a dangling link. Anything else is a real failure.
    if (error?.code !== 'ENOENT') throw error
  }
  const parent = path.dirname(absolute)
  let info = null
  try {
    info = await lstat(absolute)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (info?.isSymbolicLink()) {
    const link = await readlink(absolute)
    return resolveReal(path.resolve(parent, link), depth + 1)
  }
  if (parent === absolute) return absolute
  return path.join(
    await resolveReal(parent, depth + 1),
    path.basename(absolute),
  )
}

/** Throw when `dir`, or anything it resolves to, is inside `repoRoot`. */
export async function assertOutsideRepo(dir, repoRoot) {
  const roots = new Set([path.resolve(repoRoot), await resolveReal(repoRoot)])
  const candidates = [path.resolve(dir), await resolveReal(dir)]
  for (const root of roots) {
    for (const candidate of candidates) {
      if (isInside(root, candidate)) {
        throw new Error(
          `Screenshots must be written outside the repository (got ${dir}).`,
        )
      }
    }
  }
}

/**
 * Evidence directory: `override` when set (its old PNG/JSON files are
 * replaced), otherwise a fresh directory unique to this invocation under
 * `tmpBase`. The guard runs before anything is created, and again before any
 * file is removed.
 */
export async function prepareEvidenceDir({ override, tmpBase, repoRoot }) {
  if (override) {
    const dir = path.resolve(override)
    await assertOutsideRepo(dir, repoRoot)
    await mkdir(dir, { recursive: true })
    // Re-check now that the directory exists: the path may have changed.
    await assertOutsideRepo(dir, repoRoot)
    for (const name of await readdir(dir)) {
      if (EVIDENCE_FILE.test(name)) await rm(path.join(dir, name))
    }
    return dir
  }
  const base = path.resolve(tmpBase)
  await assertOutsideRepo(path.join(base, 'openfarm-website-verify'), repoRoot)
  return mkdtemp(path.join(base, 'openfarm-website-verify-'))
}
