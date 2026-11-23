// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(SCRIPT_DIR, '..')
export const DEFAULT_LOCKFILE_PATH = join(REPO_ROOT, 'package-lock.json')

function extractPackageName(entryPath, entry) {
  if (typeof entry?.name === 'string' && entry.name.length > 0) {
    return entry.name
  }
  const marker = 'node_modules/'
  const idx = entryPath.lastIndexOf(marker)
  return idx === -1 ? entryPath : entryPath.slice(idx + marker.length)
}

function normalizeStringArray(value) {
  if (!Array.isArray(value) || value.length === 0) return undefined
  return value.map((item) => String(item))
}

export function isLinuxX64Platform(entry) {
  const isPlatform = Boolean(entry.os || entry.cpu || entry.libc)
  if (!isPlatform) return false
  const osOk = !entry.os || entry.os.includes('linux')
  const cpuOk = !entry.cpu || entry.cpu.includes('x64')
  return osOk && cpuOk
}

export function parseLockfilePackages(lockfilePath = DEFAULT_LOCKFILE_PATH) {
  const raw = readFileSync(lockfilePath, 'utf8')
  const lock = JSON.parse(raw)
  if (
    !lock ||
    lock.lockfileVersion !== 3 ||
    typeof lock.packages !== 'object'
  ) {
    throw new Error(
      `Unsupported or invalid package-lock.json at ${lockfilePath} (expected lockfileVersion 3)`,
    )
  }

  const bySpec = new Map()
  for (const [entryPath, entry] of Object.entries(lock.packages)) {
    if (!entryPath.startsWith('node_modules/')) continue
    if (!entry || entry.link === true || typeof entry.version !== 'string') {
      continue
    }
    const name = extractPackageName(entryPath, entry)
    const spec = `${name}@${entry.version}`
    const os = normalizeStringArray(entry.os)
    const cpu = normalizeStringArray(entry.cpu)
    const libc = normalizeStringArray(entry.libc)
    const isPlatform = Boolean(os || cpu || libc)

    const existing = bySpec.get(spec)
    if (existing) {
      existing.paths.push(entryPath)
      if (!existing.resolved && typeof entry.resolved === 'string') {
        existing.resolved = entry.resolved
      }
      continue
    }

    const pkg = {
      name,
      version: entry.version,
      spec,
      os,
      cpu,
      libc,
      isPlatform,
      isLinuxX64: isLinuxX64Platform({ os, cpu, libc }),
      inBundle: Boolean(entry.inBundle),
      optional: Boolean(entry.optional),
      resolved: typeof entry.resolved === 'string' ? entry.resolved : undefined,
      integrity:
        typeof entry.integrity === 'string' ? entry.integrity : undefined,
      paths: [entryPath],
    }
    bySpec.set(spec, pkg)
  }

  return Array.from(bySpec.values()).sort((a, b) =>
    a.spec < b.spec ? -1 : a.spec > b.spec ? 1 : 0,
  )
}

function formatPlatformTag(pkg) {
  if (!pkg.isPlatform) return ''
  const parts = []
  if (pkg.os) parts.push(`os=${pkg.os.join(',')}`)
  if (pkg.cpu) parts.push(`cpu=${pkg.cpu.join(',')}`)
  if (pkg.libc) parts.push(`libc=${pkg.libc.join(',')}`)
  if (pkg.isLinuxX64) parts.push('target=linux-x64')
  return `[platform ${parts.join(' ')}]`
}

function buildRegistryTarballUrl(registryBase, resolvedUrl) {
  const parsed = new URL(resolvedUrl)
  return `${registryBase}${parsed.pathname}`
}

async function probeUrl(url, method, headers, timeoutMs) {
  const res = await fetch(url, {
    method,
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (res.body) {
    try {
      await res.body.cancel()
    } catch {
      // Ignore stream cancellation noise on early close.
    }
  }
  return res
}

async function checkSinglePackage(pkg, registryBase, timeoutMs) {
  const encodedName = encodeURIComponent(pkg.name)
  const packumentUrl = `${registryBase}/${encodedName}`
  const packumentHeaders = {
    accept: 'application/vnd.npm.install-v1+json, application/json',
  }

  if (pkg.resolved) {
    const tarballUrl = buildRegistryTarballUrl(registryBase, pkg.resolved)
    let headRes = await probeUrl(tarballUrl, 'HEAD', {}, timeoutMs)
    if (headRes.status === 405) {
      headRes = await probeUrl(tarballUrl, 'GET', {}, timeoutMs)
    }
    if (headRes.ok) {
      return { pkg, status: 'present' }
    }
    if (headRes.status !== 404 && headRes.status !== 410) {
      return {
        pkg,
        status: 'error',
        reason: `HTTP ${headRes.status} for ${tarballUrl}`,
      }
    }

    // Fallback to packument in case the mirror serves tarballs at a non-standard path.
    const packRes = await fetch(packumentUrl, {
      method: 'GET',
      headers: packumentHeaders,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (packRes.status === 404 || packRes.status === 410) {
      return { pkg, status: 'missing', reason: `HTTP ${headRes.status}` }
    }
    if (!packRes.ok) {
      return {
        pkg,
        status: 'error',
        reason: `HTTP ${packRes.status} for ${packumentUrl}`,
      }
    }
    const packument = await packRes.json()
    const versionMeta = packument?.versions?.[pkg.version]
    if (!versionMeta) {
      return {
        pkg,
        status: 'missing',
        reason: `version ${pkg.version} absent in packument`,
      }
    }
    const altTarball = versionMeta?.dist?.tarball
    if (typeof altTarball === 'string' && altTarball.length > 0) {
      const altPath = new URL(altTarball, registryBase).pathname
      const expectedPath = new URL(pkg.resolved).pathname
      if (altPath !== expectedPath) {
        const altUrl = `${registryBase}${altPath}`
        let altRes = await probeUrl(altUrl, 'HEAD', {}, timeoutMs)
        if (altRes.status === 405) {
          altRes = await probeUrl(altUrl, 'GET', {}, timeoutMs)
        }
        if (altRes.ok) {
          return { pkg, status: 'present' }
        }
        if (altRes.status === 404 || altRes.status === 410) {
          return { pkg, status: 'missing', reason: `HTTP ${altRes.status}` }
        }
        return {
          pkg,
          status: 'error',
          reason: `HTTP ${altRes.status} for ${altUrl}`,
        }
      }
    }
    return { pkg, status: 'missing', reason: `HTTP ${headRes.status}` }
  }

  const packRes = await fetch(packumentUrl, {
    method: 'GET',
    headers: packumentHeaders,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (packRes.status === 404 || packRes.status === 410) {
    return { pkg, status: 'missing', reason: `HTTP ${packRes.status}` }
  }
  if (!packRes.ok) {
    return {
      pkg,
      status: 'error',
      reason: `HTTP ${packRes.status} for ${packumentUrl}`,
    }
  }
  const packument = await packRes.json()
  if (!packument?.versions?.[pkg.version]) {
    return {
      pkg,
      status: 'missing',
      reason: `version ${pkg.version} absent in packument`,
    }
  }
  return { pkg, status: 'present' }
}

export async function checkRegistryAvailability(
  packages,
  registryUrl,
  options = {},
) {
  let parsed
  try {
    parsed = new URL(registryUrl)
  } catch {
    throw new Error(`Invalid registry URL: ${registryUrl}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported registry protocol: ${parsed.protocol}`)
  }

  const registryBase = parsed.href.replace(/\/+$/, '')
  const concurrency = Math.max(1, options.concurrency ?? 16)
  const timeoutMs = Math.max(100, options.timeoutMs ?? 15000)

  const targets = packages.filter((pkg) => !(pkg.inBundle && !pkg.resolved))
  const missing = []
  const errors = []
  let cursor = 0

  async function worker() {
    while (cursor < targets.length) {
      const index = cursor++
      const pkg = targets[index]
      try {
        const result = await checkSinglePackage(pkg, registryBase, timeoutMs)
        if (result.status === 'missing') {
          missing.push({ pkg, reason: result.reason })
        } else if (result.status === 'error') {
          errors.push({ pkg, reason: result.reason })
        }
      } catch (err) {
        errors.push({
          pkg,
          reason: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, targets.length || 1) },
    () => worker(),
  )
  await Promise.all(workers)

  if (errors.length > 0) {
    const sample = errors
      .slice(0, 5)
      .map((e) => `${e.pkg.spec}: ${e.reason}`)
      .join('; ')
    throw new Error(
      `Registry check failed for ${errors.length} package(s) against ${registryBase}: ${sample}`,
    )
  }

  missing.sort((a, b) =>
    a.pkg.spec < b.pkg.spec ? -1 : a.pkg.spec > b.pkg.spec ? 1 : 0,
  )

  return {
    registryUrl: registryBase,
    checkedCount: targets.length,
    missing,
  }
}

export function formatDepsReport(packages, registryResult = null) {
  const platformPackages = packages.filter((pkg) => pkg.isPlatform)
  const linuxX64Packages = packages.filter((pkg) => pkg.isLinuxX64)
  const missingBySpec = new Map(
    (registryResult?.missing ?? []).map((entry) => [entry.pkg.spec, entry]),
  )

  const lines = []
  lines.push(
    `Lockfile dependencies: ${packages.length} total, ${platformPackages.length} platform (${linuxX64Packages.length} linux-x64)`,
  )
  if (registryResult) {
    lines.push(
      `Registry check (${registryResult.registryUrl}): checked ${registryResult.checkedCount}, missing ${registryResult.missing.length}`,
    )
  }

  lines.push('')
  lines.push('All packages:')
  for (const pkg of packages) {
    const tags = []
    const platformTag = formatPlatformTag(pkg)
    if (platformTag) tags.push(platformTag)
    if (pkg.inBundle && !pkg.resolved) tags.push('[bundled]')
    if (registryResult) {
      const missingEntry = missingBySpec.get(pkg.spec)
      if (missingEntry) {
        tags.push(`[MISSING: ${missingEntry.reason}]`)
      }
    }
    lines.push(tags.length > 0 ? `${pkg.spec} ${tags.join(' ')}` : pkg.spec)
  }

  lines.push('')
  lines.push(`Platform packages (linux-x64: ${linuxX64Packages.length}):`)
  for (const pkg of linuxX64Packages) {
    const missingSuffix = missingBySpec.has(pkg.spec) ? ' [MISSING]' : ''
    lines.push(`${pkg.spec} ${formatPlatformTag(pkg)}${missingSuffix}`)
  }

  if (registryResult) {
    lines.push('')
    lines.push(
      `Missing from registry ${registryResult.registryUrl} (${registryResult.missing.length}):`,
    )
    if (registryResult.missing.length === 0) {
      lines.push('(none)')
    } else {
      for (const entry of registryResult.missing) {
        const platformTag = formatPlatformTag(entry.pkg)
        const suffix = platformTag
          ? ` ${platformTag} (${entry.reason})`
          : ` (${entry.reason})`
        lines.push(`${entry.pkg.spec}${suffix}`)
      }
    }
  }

  return `${lines.join('\n')}\n`
}

export async function runDepsReport(options = {}) {
  const lockfilePath = options.lockfilePath ?? DEFAULT_LOCKFILE_PATH
  const packages = parseLockfilePackages(lockfilePath)
  const registryResult = options.registryUrl
    ? await checkRegistryAvailability(packages, options.registryUrl, {
        concurrency: options.concurrency,
        timeoutMs: options.timeoutMs,
      })
    : null
  const report = formatDepsReport(packages, registryResult)
  return { packages, registryResult, report }
}

function parseCliArgs(argv) {
  const options = {
    registryUrl: undefined,
    lockfilePath: undefined,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg === '--registry') {
      const next = argv[++i]
      if (!next) throw new Error('Missing value for --registry')
      options.registryUrl = next
    } else if (arg.startsWith('--registry=')) {
      options.registryUrl = arg.slice('--registry='.length)
      if (!options.registryUrl) throw new Error('Missing value for --registry')
    } else if (arg === '--lockfile') {
      const next = argv[++i]
      if (!next) throw new Error('Missing value for --lockfile')
      options.lockfilePath = resolve(next)
    } else if (arg.startsWith('--lockfile=')) {
      const val = arg.slice('--lockfile='.length)
      if (!val) throw new Error('Missing value for --lockfile')
      options.lockfilePath = resolve(val)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return options
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isMain) {
  try {
    const cli = parseCliArgs(process.argv.slice(2))
    if (cli.help) {
      process.stdout.write(
        'Usage: node scripts/desktop-deps-report.mjs [--registry <url>] [--lockfile <path>]\n',
      )
      process.exit(0)
    }
    const { report } = await runDepsReport({
      registryUrl: cli.registryUrl,
      lockfilePath: cli.lockfilePath,
    })
    process.stdout.write(report)
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exit(1)
  }
}
