// SPDX-License-Identifier: MIT
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(SCRIPT_DIR, '..')
export const DEFAULT_ARCHIVE_PATH = join(
  REPO_ROOT,
  'open3dfarmmanager-npm-cache-linux-x64.tar.gz',
)

const SENSITIVE_HEADER_RE =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-npm-.*|.*token.*|.*secret.*)$/i

export function listLinuxX64LibcTargets(lock) {
  const targets = ['glibc']
  const hasMusl = Object.values(lock?.packages ?? {}).some((entry) => {
    if (!entry || typeof entry !== 'object') return false
    const osOk = !entry.os || entry.os.includes('linux')
    const cpuOk = !entry.cpu || entry.cpu.includes('x64')
    const muslOk = Array.isArray(entry.libc) && entry.libc.includes('musl')
    return osOk && cpuOk && muslOk
  })
  if (hasMusl) {
    targets.push('musl')
  }
  return targets
}

function stripUrlCredentials(value) {
  if (typeof value !== 'string') return value
  try {
    const parsed = new URL(value)
    if (!parsed.username && !parsed.password) return value
    parsed.username = ''
    parsed.password = ''
    return parsed.href
  } catch {
    return value
  }
}

function sanitizeIndexRecord(record) {
  let changed = false
  if (typeof record.key === 'string' && record.key.includes('@')) {
    const prefix = 'make-fetch-happen:request-cache:'
    if (record.key.startsWith(prefix)) {
      const rawUrl = record.key.slice(prefix.length)
      const cleanedUrl = stripUrlCredentials(rawUrl)
      if (cleanedUrl !== rawUrl) {
        record.key = `${prefix}${cleanedUrl}`
        changed = true
      }
    }
  }
  if (record.metadata && typeof record.metadata === 'object') {
    if (typeof record.metadata.url === 'string') {
      const cleanedUrl = stripUrlCredentials(record.metadata.url)
      if (cleanedUrl !== record.metadata.url) {
        record.metadata.url = cleanedUrl
        changed = true
      }
    }
    if (
      record.metadata.reqHeaders &&
      typeof record.metadata.reqHeaders === 'object' &&
      Object.keys(record.metadata.reqHeaders).length > 0
    ) {
      record.metadata.reqHeaders = {}
      changed = true
    }
    if (
      record.metadata.resHeaders &&
      typeof record.metadata.resHeaders === 'object'
    ) {
      for (const headerName of Object.keys(record.metadata.resHeaders)) {
        if (SENSITIVE_HEADER_RE.test(headerName)) {
          delete record.metadata.resHeaders[headerName]
          changed = true
        }
      }
    }
  }
  return changed
}

function copyTreeFiltered(srcDir, destDir, onFile) {
  mkdirSync(destDir, { recursive: true })
  let count = 0
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = join(srcDir, entry.name)
    const destPath = join(destDir, entry.name)
    if (entry.isDirectory()) {
      count += copyTreeFiltered(srcPath, destPath, onFile)
    } else if (entry.isFile()) {
      onFile(srcPath, destPath)
      count++
    }
  }
  return count
}

export function scrubCacacheToCleanDir(sourceCacheDir, destCacheDir) {
  const srcCacache = join(sourceCacheDir, '_cacache')
  const srcContent = join(srcCacache, 'content-v2')
  const srcIndex = join(srcCacache, 'index-v5')
  if (!existsSync(srcContent) || !existsSync(srcIndex)) {
    throw new Error(
      `Expected populated _cacache/content-v2 and _cacache/index-v5 in ${sourceCacheDir}`,
    )
  }

  const destCacache = join(destCacheDir, '_cacache')
  const destContent = join(destCacache, 'content-v2')
  const destIndex = join(destCacache, 'index-v5')

  const contentFileCount = copyTreeFiltered(
    srcContent,
    destContent,
    (srcPath, destPath) => {
      copyFileSync(srcPath, destPath)
    },
  )

  const indexFileCount = copyTreeFiltered(
    srcIndex,
    destIndex,
    (srcPath, destPath) => {
      const raw = readFileSync(srcPath, 'utf8')
      const outLines = []
      for (const line of raw.split('\n')) {
        if (!line) continue
        const tabIdx = line.indexOf('\t')
        if (tabIdx === -1) {
          throw new Error(`Invalid cacache index entry in ${srcPath}`)
        }
        const jsonPart = line.slice(tabIdx + 1)
        const parsed = JSON.parse(jsonPart)
        const changed = sanitizeIndexRecord(parsed)
        const finalJson = changed ? JSON.stringify(parsed) : jsonPart
        const sha1 = createHash('sha1').update(finalJson).digest('hex')
        outLines.push(`\n${sha1}\t${finalJson}`)
      }
      writeFileSync(destPath, outLines.join(''), 'utf8')
    },
  )

  return { contentFileCount, indexFileCount }
}

function stageManifest(source, destination) {
  const manifest = JSON.parse(readFileSync(source, 'utf8'))
  // npm can run workspace prepare hooks even with --ignore-scripts.
  // The staged dependencies target another platform and must not be loaded.
  delete manifest.scripts
  writeFileSync(destination, JSON.stringify(manifest))
}

function stageProjectManifests(repoRoot, lockfilePath, stageProjDir) {
  const lockRaw = readFileSync(lockfilePath, 'utf8')
  const lock = JSON.parse(lockRaw)
  if (
    !lock ||
    lock.lockfileVersion !== 3 ||
    typeof lock.packages !== 'object'
  ) {
    throw new Error(
      `Unsupported or invalid package-lock.json at ${lockfilePath} (expected lockfileVersion 3)`,
    )
  }

  mkdirSync(stageProjDir, { recursive: true })
  stageManifest(
    join(repoRoot, 'package.json'),
    join(stageProjDir, 'package.json'),
  )
  copyFileSync(lockfilePath, join(stageProjDir, 'package-lock.json'))

  const npmrcPath = join(repoRoot, '.npmrc')
  if (existsSync(npmrcPath)) {
    copyFileSync(npmrcPath, join(stageProjDir, '.npmrc'))
  }

  for (const key of Object.keys(lock.packages)) {
    if (!key || key.startsWith('node_modules/')) continue
    const workspacePkg = join(repoRoot, key, 'package.json')
    if (!existsSync(workspacePkg)) continue
    const destDir = join(stageProjDir, key)
    mkdirSync(destDir, { recursive: true })
    stageManifest(workspacePkg, join(destDir, 'package.json'))
  }

  return lock
}

function runCommandOrThrow(bin, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(bin, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', rejectPromise)
    child.on('close', (status) => {
      if (status !== 0) {
        const details =
          stderr.trim() || stdout.trim() || `exit status ${status}`
        rejectPromise(new Error(`${bin} ${args.join(' ')} failed: ${details}`))
        return
      }
      resolvePromise({ status, stdout, stderr })
    })
  })
}

export async function buildDesktopBundle(options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT
  const lockfilePath =
    options.lockfilePath ?? join(repoRoot, 'package-lock.json')
  const outPath = resolve(options.outPath ?? DEFAULT_ARCHIVE_PATH)
  const registryUrl = options.registryUrl
  const env = { ...(options.env ?? process.env) }
  delete env.npm_config_cache
  delete env.NPM_CONFIG_CACHE
  const log = options.log ?? ((line) => process.stdout.write(`${line}\n`))

  if (registryUrl) {
    let parsed
    try {
      parsed = new URL(registryUrl)
    } catch {
      throw new Error(`Invalid registry URL: ${registryUrl}`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Unsupported registry protocol: ${parsed.protocol}`)
    }
  }

  const stagingRoot = mkdtempSync(join(tmpdir(), 'openfarm-desktop-bundle-'))
  try {
    const stageProjDir = join(stagingRoot, 'proj')
    const rawCacheDir = join(stagingRoot, 'raw-cache')
    const cleanCacheDir = join(stagingRoot, 'clean-cache')
    mkdirSync(rawCacheDir, { recursive: true })
    mkdirSync(cleanCacheDir, { recursive: true })

    const lock = stageProjectManifests(repoRoot, lockfilePath, stageProjDir)
    const libcTargets = listLinuxX64LibcTargets(lock)
    const baseNpmFlags = [
      'ci',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-update-notifier',
      '--os=linux',
      '--cpu=x64',
      '--cache',
      rawCacheDir,
    ]
    if (registryUrl) {
      baseNpmFlags.push('--registry', registryUrl)
    }

    for (let i = 0; i < libcTargets.length; i++) {
      const libc = libcTargets[i]
      const args = [...baseNpmFlags, `--libc=${libc}`]
      if (i > 0) args.push('--prefer-offline')
      log(`Populating npm cache for linux-x64 (${libc})...`)
      await runCommandOrThrow('npm', args, { cwd: stageProjDir, env })
    }

    await runCommandOrThrow(
      'npm',
      ['cache', 'verify', '--no-update-notifier', '--cache', rawCacheDir],
      { cwd: stageProjDir, env },
    )

    const { contentFileCount, indexFileCount } = scrubCacacheToCleanDir(
      rawCacheDir,
      cleanCacheDir,
    )

    mkdirSync(dirname(outPath), { recursive: true })
    await runCommandOrThrow(
      'tar',
      ['-czf', outPath, '-C', cleanCacheDir, '_cacache'],
      {
        cwd: repoRoot,
        env: { ...env, COPYFILE_DISABLE: '1' },
      },
    )

    log(
      `Desktop offline npm cache written to ${outPath} (${contentFileCount} cached blobs, ${indexFileCount} index entries, targets: ${libcTargets.map((l) => `linux-x64-${l}`).join(', ')})`,
    )
    return {
      archivePath: outPath,
      targets: libcTargets,
      contentFileCount,
      indexFileCount,
    }
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true })
  }
}

function parseCliArgs(argv) {
  const options = {
    outPath: undefined,
    registryUrl: undefined,
    lockfilePath: undefined,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg === '--out') {
      const next = argv[++i]
      if (!next) throw new Error('Missing value for --out')
      options.outPath = resolve(next)
    } else if (arg.startsWith('--out=')) {
      const val = arg.slice('--out='.length)
      if (!val) throw new Error('Missing value for --out')
      options.outPath = resolve(val)
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
        'Usage: node scripts/desktop-bundle.mjs [--out <archive.tar.gz>] [--registry <url>] [--lockfile <path>]\n',
      )
      process.exit(0)
    }
    await buildDesktopBundle({
      outPath: cli.outPath,
      registryUrl: cli.registryUrl,
      lockfilePath: cli.lockfilePath,
    })
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exit(1)
  }
}
