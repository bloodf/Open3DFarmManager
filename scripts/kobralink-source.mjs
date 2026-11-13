#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Source fetch, checkout verification and Compose isolation verifier for
// external unmodified KobraLink. Never vendors upstream code or starts engines.

import { execFile, execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
export const REPOSITORY_ROOT = resolve(SCRIPT_DIR, '..')
export const LOCK_FILE_PATH = join(
  REPOSITORY_ROOT,
  'infra/kobralink/upstream.lock',
)
export const COMPOSE_FILE_PATH = join(
  REPOSITORY_ROOT,
  'infra/kobralink/docker-compose.yml',
)

export const SUPPORTED_UPSTREAM_ENV_KEYS = Object.freeze([
  'NODE_ENV',
  'KOBRALINK_DATA_DIR',
  'DATABASE_URL',
  'KOBRALINK_PORT',
  'KOBRALINK_WEB_DIR',
  'KOBRALINK_CERTS_DIR',
  'KOBRALINK_EXTRA_ORIGINS',
  'KOBRALINK_TRUSTED_PROXIES',
  'KOBRALINK_IP_HEADERS',
  'KOBRALINK_UPDATE_REPO',
  'KOBRALINK_VERSION',
  'KOBRALINK_PACKAGED',
  'KOBRALINK_FFMPEG',
  'KOBRALINK_DETECTION_MODEL_URL',
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_URL',
])

export class SourceError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'SourceError'
    this.code = options.code ?? 'ERR_KOBRALINK_SOURCE'
  }
}

function sourceError(message, code) {
  return new SourceError(message, { code })
}

function normalizeRepoUrl(url) {
  return String(url ?? '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .toLowerCase()
}

export function loadLockMetadata(lockPath = LOCK_FILE_PATH) {
  if (!existsSync(lockPath)) {
    throw sourceError(
      `Lock metadata file not found at ${lockPath}`,
      'ERR_LOCK_NOT_FOUND',
    )
  }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(lockPath, 'utf8'))
  } catch (err) {
    throw sourceError(
      `Failed to parse lock metadata: ${err.message}`,
      'ERR_LOCK_PARSE',
    )
  }
  const upstream = parsed?.upstream
  const policy = parsed?.policy
  if (
    parsed?.schema !== 'open3dfarmmanager.kobralink-pin.v1' ||
    !upstream ||
    typeof upstream.repository !== 'string' ||
    !/^[0-9a-f]{40}$/.test(String(upstream.commit ?? '')) ||
    typeof upstream.version !== 'string' ||
    upstream.license !== 'GPL-3.0-only' ||
    upstream.dockerfile !== 'infra/Dockerfile' ||
    !policy ||
    policy.vendorUpstream !== false ||
    policy.commitArtifactsOrCertificates !== false ||
    policy.redistributeImages !== false ||
    policy.processSeparationSettlesLicensing !== false
  ) {
    throw sourceError('Invalid lock metadata structure', 'ERR_LOCK_INVALID')
  }
  return parsed
}

/**
 * Returns canonical roots that belong to the repository or its linked worktrees.
 */
export function repositoryExclusionRoots() {
  const roots = new Set()
  const add = (candidate) => {
    if (!candidate || !isAbsolute(candidate)) return
    try {
      roots.add(realpathSync(candidate))
    } catch {
      roots.add(resolve(candidate))
    }
  }

  add(REPOSITORY_ROOT)

  try {
    const common = execFileSync(
      'git',
      [
        '-C',
        REPOSITORY_ROOT,
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
      ],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim()
    add(common)
    add(resolve(common, '..'))
  } catch {
    // Non-fatal if git query is unavailable
  }

  try {
    const worktrees = execFileSync(
      'git',
      ['-C', REPOSITORY_ROOT, 'worktree', 'list', '--porcelain', '-z'],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    if (worktrees.endsWith('\0\0')) {
      for (const record of worktrees.slice(0, -2).split('\0\0')) {
        const fields = record.split('\0')
        const first = fields[0]
        if (first?.startsWith('worktree ')) {
          add(first.slice(9))
        }
      }
    }
  } catch {
    // Non-fatal if worktree listing fails
  }

  return [...roots]
}

function assertNoSymlinkChain(targetAbsolute) {
  const parts = resolve(targetAbsolute).split('/').filter(Boolean)
  let current = '/'
  for (const part of parts) {
    current = join(current, part)
    if (!existsSync(current)) break
    const lst = lstatSync(current)
    if (lst.isSymbolicLink()) {
      throw sourceError(
        `Symbolic link is not permitted in destination path: ${current}`,
        'ERR_SYMLINK_NOT_ALLOWED',
      )
    }
  }
}

function assertOwnedByCurrentUser(pathToCheck, expectedUid) {
  if (typeof expectedUid !== 'number') return
  const st = lstatSync(pathToCheck)
  if (st.uid !== expectedUid) {
    throw sourceError(
      `Path is not owned by the current user (uid ${st.uid} !== ${expectedUid}): ${pathToCheck}`,
      'ERR_NOT_OWNED',
    )
  }
}

/**
 * Refuses paths that are inside the repository or any of its worktrees,
 * contain symlinks in their chain, or are not owned by the current user.
 */
export function assertExternalDestination(destinationPath, options = {}) {
  if (
    !destinationPath ||
    typeof destinationPath !== 'string' ||
    destinationPath.trim() === ''
  ) {
    throw sourceError(
      'Destination path must be a non-empty string',
      'ERR_INVALID_PATH',
    )
  }
  if (destinationPath.includes('\0')) {
    throw sourceError(
      'Destination path must not contain null bytes',
      'ERR_INVALID_PATH',
    )
  }

  const expectedUid =
    options.expectedUid !== undefined
      ? options.expectedUid
      : typeof process.getuid === 'function'
        ? process.getuid()
        : undefined
  const exclusionRoots = options.exclusionRoots ?? repositoryExclusionRoots()

  const absolute = resolve(destinationPath)
  assertNoSymlinkChain(absolute)

  let existingAncestor = absolute
  const missingSegments = []
  while (!existsSync(existingAncestor)) {
    const parent = resolve(existingAncestor, '..')
    if (parent === existingAncestor) break
    missingSegments.unshift(
      existingAncestor.slice(parent === '/' ? 1 : parent.length + 1),
    )
    existingAncestor = parent
  }

  if (existsSync(existingAncestor)) {
    assertNoSymlinkChain(existingAncestor)
    assertOwnedByCurrentUser(existingAncestor, expectedUid)
    if (existingAncestor === absolute) {
      const st = statSync(absolute)
      if (!st.isDirectory()) {
        throw sourceError(
          `Destination path exists and is not a directory: ${absolute}`,
          'ERR_NOT_DIRECTORY',
        )
      }
    }
  }

  const realAncestor = existsSync(existingAncestor)
    ? realpathSync(existingAncestor)
    : existingAncestor
  const canonical =
    missingSegments.length > 0
      ? join(realAncestor, ...missingSegments)
      : realAncestor

  for (const root of exclusionRoots) {
    const rel = relative(root, canonical)
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
      throw sourceError(
        'Destination must stay strictly outside Open3DFarmManager and all linked worktrees',
        'ERR_INSIDE_REPOSITORY',
      )
    }
  }

  return canonical
}

function verifyUpstreamManifests(verifiedPath, lockMetadata) {
  const dockerfilePath = join(verifiedPath, lockMetadata.upstream.dockerfile)
  if (
    !existsSync(dockerfilePath) ||
    lstatSync(dockerfilePath).isSymbolicLink()
  ) {
    throw sourceError(
      `Expected upstream Dockerfile missing at ${dockerfilePath}`,
      'ERR_DOCKERFILE_MISSING',
    )
  }

  const rootPkgPath = join(verifiedPath, 'package.json')
  const apiPkgPath = join(verifiedPath, 'apps/api/package.json')
  for (const pkgPath of [rootPkgPath, apiPkgPath]) {
    if (!existsSync(pkgPath) || lstatSync(pkgPath).isSymbolicLink()) {
      throw sourceError(
        `Expected upstream package manifest missing at ${pkgPath}`,
        'ERR_MANIFEST_MISSING',
      )
    }
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    if (pkg.version !== lockMetadata.upstream.version) {
      throw sourceError(
        `Upstream version mismatch in ${pkgPath}: expected ${lockMetadata.upstream.version}, got ${pkg.version}`,
        'ERR_VERSION_MISMATCH',
      )
    }
  }
  const apiPkg = JSON.parse(readFileSync(apiPkgPath, 'utf8'))
  if (apiPkg.license !== lockMetadata.upstream.license) {
    throw sourceError(
      `Upstream license mismatch in ${apiPkgPath}: expected ${lockMetadata.upstream.license}, got ${apiPkg.license}`,
      'ERR_LICENSE_MISMATCH',
    )
  }
}

/**
 * Verifies that an existing external directory contains the exact pinned clean checkout.
 */
export async function verifyCheckout(
  targetPath,
  lockMetadata = loadLockMetadata(),
  options = {},
) {
  const verifiedPath = assertExternalDestination(targetPath, options)
  if (!existsSync(verifiedPath)) {
    throw sourceError(
      `Target directory does not exist: ${verifiedPath}`,
      'ERR_DIR_NOT_FOUND',
    )
  }

  const gitDir = join(verifiedPath, '.git')
  if (!existsSync(gitDir)) {
    throw sourceError(
      `Target directory is not a git repository: ${verifiedPath}`,
      'ERR_NOT_GIT_REPO',
    )
  }
  if (lstatSync(gitDir).isSymbolicLink()) {
    throw sourceError(
      'Git directory must not be a symbolic link',
      'ERR_SYMLINK_NOT_ALLOWED',
    )
  }

  const expectedSha = lockMetadata.upstream.commit

  let headSha
  try {
    const { stdout } = await execFileAsync('git', [
      '-C',
      verifiedPath,
      'rev-parse',
      '--verify',
      'HEAD',
    ])
    headSha = stdout.trim()
  } catch (err) {
    throw sourceError(
      `Failed to query HEAD commit in ${verifiedPath}: ${err.message}`,
      'ERR_GIT_REV_PARSE',
    )
  }

  if (headSha !== expectedSha) {
    throw sourceError(
      `Commit mismatch in ${verifiedPath}. Expected ${expectedSha}, got ${headSha}`,
      'ERR_SHA_MISMATCH',
    )
  }

  try {
    const { stdout: remoteUrl } = await execFileAsync('git', [
      '-C',
      verifiedPath,
      'remote',
      'get-url',
      'origin',
    ])
    if (
      normalizeRepoUrl(remoteUrl) !==
      normalizeRepoUrl(lockMetadata.upstream.repository)
    ) {
      throw sourceError(
        `Origin repository mismatch in ${verifiedPath}: expected ${lockMetadata.upstream.repository}, got ${remoteUrl.trim()}`,
        'ERR_REMOTE_MISMATCH',
      )
    }
  } catch (err) {
    if (err instanceof SourceError) throw err
    // Local detached archive without 'origin' remote is allowed if SHA and manifests match
  }

  let statusOutput
  try {
    const { stdout } = await execFileAsync('git', [
      '-C',
      verifiedPath,
      'status',
      '--porcelain',
      '--untracked-files=all',
    ])
    statusOutput = stdout.trim()
  } catch (err) {
    throw sourceError(
      `Failed to query working tree status in ${verifiedPath}: ${err.message}`,
      'ERR_GIT_STATUS',
    )
  }

  if (statusOutput.length > 0) {
    throw sourceError(
      `Working tree in ${verifiedPath} is dirty or modified. Refusing non-clean checkout.`,
      'ERR_DIRTY_TREE',
    )
  }

  verifyUpstreamManifests(verifiedPath, lockMetadata)

  return {
    verified: true,
    path: verifiedPath,
    commit: headSha,
    version: lockMetadata.upstream.version,
  }
}

/**
 * Clones the external repository at the pinned commit without shell interpolation,
 * or idempotently verifies an existing clean pinned checkout. Refuses dirty,
 * mismatched, non-git or non-owned existing directories without mutating them.
 */
export async function cloneOrFetch(
  targetPath,
  lockMetadata = loadLockMetadata(),
  options = {},
) {
  const verifiedPath = assertExternalDestination(targetPath, options)
  const repoUrl = lockMetadata.upstream.repository
  const targetCommit = lockMetadata.upstream.commit

  if (existsSync(verifiedPath)) {
    const entries = readdirSync(verifiedPath)
    if (entries.length > 0) {
      // Idempotent if already a clean checkout at the exact pinned commit;
      // refuses without mutating if dirty, mismatched SHA, or non-git directory.
      return verifyCheckout(verifiedPath, lockMetadata, options)
    }
  }

  await execFileAsync('git', ['clone', '--no-checkout', repoUrl, verifiedPath])
  await execFileAsync('git', [
    '-C',
    verifiedPath,
    'fetch',
    '--depth',
    '1',
    'origin',
    targetCommit,
  ])
  await execFileAsync('git', [
    '-C',
    verifiedPath,
    'checkout',
    '--detach',
    targetCommit,
  ])

  return verifyCheckout(verifiedPath, lockMetadata, options)
}

function unquoteYamlScalar(raw) {
  const trimmed = raw.trim()
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function stripYamlComment(line) {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    else if (ch === '#' && !inSingle && !inDouble) {
      if (i === 0 || /\s/.test(line[i - 1])) {
        return line.slice(0, i).trimEnd()
      }
    }
  }
  return line.trimEnd()
}

/**
 * Minimal indentation-aware Compose YAML parser for infra/kobralink/docker-compose.yml.
 */
export function parseComposeRecipe(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw sourceError('Compose recipe is empty', 'ERR_COMPOSE_EMPTY')
  }
  const rawLines = text.split(/\r?\n/)
  const entries = []
  for (let i = 0; i < rawLines.length; i++) {
    const stripped = stripYamlComment(rawLines[i])
    if (!stripped.trim()) continue
    const indent = stripped.length - stripped.trimStart().length
    entries.push({ indent, content: stripped.trim(), line: i + 1 })
  }

  function parseBlock(startIndex, parentIndent) {
    const first = entries[startIndex]
    if (!first) return [{}, startIndex]
    if (first.content.startsWith('- ')) {
      const list = []
      let idx = startIndex
      const listIndent = first.indent
      while (idx < entries.length && entries[idx].indent === listIndent) {
        const item = entries[idx]
        if (!item.content.startsWith('- ')) break
        list.push(unquoteYamlScalar(item.content.slice(2)))
        idx++
      }
      return [list, idx]
    }

    const map = {}
    let idx = startIndex
    const mapIndent = first.indent
    while (idx < entries.length && entries[idx].indent === mapIndent) {
      const item = entries[idx]
      if (item.content.startsWith('- ')) break
      const colonIdx = item.content.indexOf(':')
      if (colonIdx <= 0) {
        throw sourceError(
          `Invalid Compose line ${item.line}: ${item.content}`,
          'ERR_COMPOSE_PARSE',
        )
      }
      const key = item.content.slice(0, colonIdx).trim()
      const rest = item.content.slice(colonIdx + 1).trim()
      idx++
      if (rest !== '') {
        if (rest.startsWith('[') && rest.endsWith(']')) {
          map[key] = rest
            .slice(1, -1)
            .split(',')
            .map((v) => unquoteYamlScalar(v))
            .filter(Boolean)
        } else {
          map[key] = unquoteYamlScalar(rest)
        }
      } else if (idx < entries.length && entries[idx].indent > mapIndent) {
        const [nested, nextIdx] = parseBlock(idx, mapIndent)
        map[key] = nested
        idx = nextIdx
      } else {
        map[key] = ''
      }
    }
    return [map, idx]
  }

  const [parsed] = parseBlock(0, -1)
  return parsed
}

/**
 * Parses and validates infra/kobralink/docker-compose.yml against packaging and isolation rules.
 */
export function verifyComposeRecipe(
  composePath = COMPOSE_FILE_PATH,
  lockMetadata = loadLockMetadata(),
) {
  if (!existsSync(composePath)) {
    throw sourceError(
      `Compose file not found at ${composePath}`,
      'ERR_COMPOSE_NOT_FOUND',
    )
  }
  const raw = readFileSync(composePath, 'utf8')
  const doc = parseComposeRecipe(raw)

  const services = doc?.services
  if (!services || typeof services !== 'object' || Array.isArray(services)) {
    throw sourceError(
      'Compose file must define services',
      'ERR_COMPOSE_INVALID',
    )
  }
  const serviceNames = Object.keys(services)
  if (serviceNames.length !== 1 || serviceNames[0] !== 'kobralink') {
    throw sourceError(
      `Compose file must define only the kobralink service, found: ${serviceNames.join(', ')}`,
      'ERR_COMPOSE_SERVICES',
    )
  }

  const svc = services.kobralink
  const shortSha = lockMetadata.upstream.commit.slice(0, 12)

  // 1. Local image tag and external build context from upstream Dockerfile
  if (
    typeof svc.image !== 'string' ||
    !svc.image.includes(`kobralink-local:${shortSha}`)
  ) {
    throw sourceError(
      `Service image must default to local pinned tag kobralink-local:${shortSha}`,
      'ERR_COMPOSE_IMAGE',
    )
  }
  if (
    !svc.build ||
    typeof svc.build !== 'object' ||
    typeof svc.build.context !== 'string' ||
    !svc.build.context.includes('KOBRALINK_SRC:?') ||
    svc.build.dockerfile !== lockMetadata.upstream.dockerfile
  ) {
    throw sourceError(
      'Service build must require external KOBRALINK_SRC and build infra/Dockerfile',
      'ERR_COMPOSE_BUILD',
    )
  }

  // 2. Strictly loopback-only management port 7100; no Moonraker ports
  const ports = svc.ports
  if (!Array.isArray(ports) || ports.length !== 1) {
    throw sourceError(
      'Service must publish only a single loopback management port',
      'ERR_COMPOSE_PORTS',
    )
  }
  const portSpec = String(ports[0])
  if (
    portSpec !== '127.0.0.1:${KOBRALINK_MGMT_PORT:-7100}:7100' ||
    portSpec.includes('0.0.0.0') ||
    /712[5-9]|713[0-9]|7140/.test(portSpec)
  ) {
    throw sourceError(
      `Management port must map strictly to 127.0.0.1:\${KOBRALINK_MGMT_PORT:-7100}:7100, got: ${portSpec}`,
      'ERR_COMPOSE_PORTS',
    )
  }
  if (Array.isArray(svc.expose) && svc.expose.length > 0) {
    throw sourceError(
      'Service must not declare extra exposed ports',
      'ERR_COMPOSE_PORTS',
    )
  }

  // 3. No host networking, privileged execution, or host namespace sharing
  if (
    svc.network_mode !== undefined ||
    svc.privileged !== undefined ||
    svc.pid !== undefined ||
    svc.ipc !== undefined ||
    svc.userns_mode !== undefined
  ) {
    throw sourceError(
      'Host networking, privileged mode and host namespace sharing are forbidden',
      'ERR_COMPOSE_PRIVILEGE',
    )
  }

  // 4. Least-privilege flags: no-new-privileges:true and cap_drop: [ALL]
  if (
    !Array.isArray(svc.security_opt) ||
    !svc.security_opt.includes('no-new-privileges:true')
  ) {
    throw sourceError(
      'Service must set security_opt no-new-privileges:true',
      'ERR_COMPOSE_SECURITY_OPT',
    )
  }
  if (!Array.isArray(svc.cap_drop) || !svc.cap_drop.includes('ALL')) {
    throw sourceError(
      'Service must drop ALL capabilities',
      'ERR_COMPOSE_CAP_DROP',
    )
  }

  // 5. Environment variables: only supported upstream names, empty update repo & extra origins, independent secret/DB
  const env = svc.environment
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    throw sourceError('Service must define environment map', 'ERR_COMPOSE_ENV')
  }
  for (const key of Object.keys(env)) {
    if (!SUPPORTED_UPSTREAM_ENV_KEYS.includes(key)) {
      throw sourceError(
        `Unsupported upstream environment variable in Compose: ${key}`,
        'ERR_COMPOSE_UNSUPPORTED_ENV',
      )
    }
  }
  if (
    env.NODE_ENV !== 'production' ||
    env.KOBRALINK_DATA_DIR !== '/data' ||
    env.DATABASE_URL !== 'file:/data/kobralink.db' ||
    String(env.KOBRALINK_PORT) !== '7100' ||
    env.KOBRALINK_UPDATE_REPO !== '' ||
    env.KOBRALINK_EXTRA_ORIGINS !== '' ||
    typeof env.BETTER_AUTH_SECRET !== 'string' ||
    !env.BETTER_AUTH_SECRET.includes('KOBRALINK_AUTH_SECRET:?') ||
    env.BETTER_AUTH_SECRET.includes('O3DFM_') ||
    env.BETTER_AUTH_URL !== 'http://127.0.0.1:${KOBRALINK_MGMT_PORT:-7100}'
  ) {
    throw sourceError(
      'Service environment violates isolation, loopback origin, empty update/extra-origins, or independent secret/DB rules',
      'ERR_COMPOSE_ENV_VALUES',
    )
  }

  // 6. Dedicated volume only; no docker.sock, no host bind mounts, no shared OpenFarm volumes
  const volumes = svc.volumes
  if (
    !Array.isArray(volumes) ||
    volumes.length !== 1 ||
    volumes[0] !== 'openfarm-kobralink-data:/data'
  ) {
    throw sourceError(
      'Service must mount only the dedicated volume openfarm-kobralink-data:/data',
      'ERR_COMPOSE_VOLUMES',
    )
  }
  if (
    !doc.volumes ||
    typeof doc.volumes !== 'object' ||
    !doc.volumes['openfarm-kobralink-data'] ||
    Object.keys(doc.volumes).length !== 1
  ) {
    throw sourceError(
      'Compose must declare only the dedicated openfarm-kobralink-data volume',
      'ERR_COMPOSE_VOLUMES',
    )
  }

  // 7. Resource limits and healthcheck
  if (!svc.cpus || !svc.mem_limit || !svc.pids_limit) {
    throw sourceError(
      'Service must declare CPU, memory and PID resource limits',
      'ERR_COMPOSE_LIMITS',
    )
  }
  if (
    !svc.healthcheck ||
    !Array.isArray(svc.healthcheck.test) ||
    !svc.healthcheck.test.some((part) =>
      String(part).includes('http://127.0.0.1:7100/api/auth/ok'),
    )
  ) {
    throw sourceError(
      'Service must include loopback /api/auth/ok healthcheck',
      'ERR_COMPOSE_HEALTHCHECK',
    )
  }

  return {
    verified: true,
    service: 'kobralink',
    commit: lockMetadata.upstream.commit,
    shortSha,
  }
}

async function main() {
  const args = process.argv.slice(2)
  const command = args[0]
  const targetPath = args[1]

  if (!command || !['verify', 'clone'].includes(command) || !targetPath) {
    console.error(
      'Usage: node scripts/kobralink-source.mjs <verify|clone> <external-destination-path>',
    )
    process.exit(1)
  }

  try {
    const lock = loadLockMetadata()
    const res =
      command === 'verify'
        ? await verifyCheckout(targetPath, lock)
        : await cloneOrFetch(targetPath, lock)
    console.log(JSON.stringify(res, null, 2))
  } catch (err) {
    console.error(`Error: ${err.message} (${err.code || 'UNKNOWN'})`)
    process.exit(1)
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main()
}
