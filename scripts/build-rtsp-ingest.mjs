// SPDX-License-Identifier: MIT
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(SCRIPT_DIR, '..')
export const RTSP_INGEST_DIR = join(REPO_ROOT, 'tools/rtsp-ingest')
export const RTSP_INGEST_GO_MOD = join(RTSP_INGEST_DIR, 'go.mod')
export const RTSP_INGEST_BIN_DIR = join(RTSP_INGEST_DIR, 'bin')

export function parseVersionTuple(raw) {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(raw).trim())
  if (!match) return undefined
  return [
    Number(match[1]),
    Number(match[2]),
    match[3] !== undefined ? Number(match[3]) : 0,
  ]
}

export function compareGoVersions(a, b) {
  const tupleA = Array.isArray(a) ? a : parseVersionTuple(a)
  const tupleB = Array.isArray(b) ? b : parseVersionTuple(b)
  if (!tupleA || !tupleB) throw new Error('Invalid Go version tuple')
  for (let i = 0; i < 3; i++) {
    if (tupleA[i] !== tupleB[i]) return tupleA[i] - tupleB[i]
  }
  return 0
}

export function parseGoModMinVersion(goModPath = RTSP_INGEST_GO_MOD) {
  const content = readFileSync(goModPath, 'utf8')
  const match = /^go\s+(\d+\.\d+(?:\.\d+)?)\s*$/m.exec(content)
  if (!match) {
    throw new Error(`Missing go directive in ${goModPath}`)
  }
  return match[1]
}

export function parseGoVersionOutput(output) {
  const match = /\bgo(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(output))
  if (!match) return undefined
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = match[3] !== undefined ? Number(match[3]) : 0
  return {
    version: `${major}.${minor}.${patch}`,
    tuple: [major, minor, patch],
  }
}

export function probeGoToolchain(options = {}) {
  const env = options.env ?? process.env
  const goBin = options.goBin ?? env.RTSP_INGEST_GO_BIN ?? 'go'
  const minGoVersion =
    options.minGoVersion ??
    parseGoModMinVersion(options.goModPath ?? RTSP_INGEST_GO_MOD)
  const result = spawnSync(goBin, ['version'], {
    encoding: 'utf8',
    env: {
      ...env,
      GOPROXY: 'off',
      GOTOOLCHAIN: 'local',
      GOWORK: 'off',
    },
  })
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      reason: 'go-missing',
      minGoVersion,
      foundGoVersion: undefined,
      message: `rtsp-ingest build skipped: go is not available on PATH (requires go >= ${minGoVersion}); RTSP ingest helper is unavailable.`,
    }
  }
  const parsed = parseGoVersionOutput(
    `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
  )
  if (!parsed) {
    return {
      ok: false,
      reason: 'go-missing',
      minGoVersion,
      foundGoVersion: undefined,
      message: `rtsp-ingest build skipped: unable to parse go version output (requires go >= ${minGoVersion}); RTSP ingest helper is unavailable.`,
    }
  }
  if (compareGoVersions(parsed.tuple, minGoVersion) < 0) {
    return {
      ok: false,
      reason: 'go-too-old',
      minGoVersion,
      foundGoVersion: parsed.version,
      message: `rtsp-ingest build skipped: found go ${parsed.version}, requires go >= ${minGoVersion}; RTSP ingest helper is unavailable.`,
    }
  }
  return {
    ok: true,
    reason: undefined,
    minGoVersion,
    foundGoVersion: parsed.version,
    message: `go ${parsed.version} satisfies minimum go >= ${minGoVersion}`,
  }
}

export function buildRtspIngest(options = {}) {
  const env = options.env ?? process.env
  const goBin = options.goBin ?? env.RTSP_INGEST_GO_BIN ?? 'go'
  const toolDir = options.toolDir ?? RTSP_INGEST_DIR
  const goModPath = options.goModPath ?? join(toolDir, 'go.mod')
  const binDir =
    options.binDir ?? env.RTSP_INGEST_BIN_DIR ?? join(toolDir, 'bin')
  const log = options.log ?? ((line) => process.stdout.write(`${line}\n`))
  const probe = probeGoToolchain({
    env,
    goBin,
    goModPath,
    minGoVersion: options.minGoVersion,
  })
  if (!probe.ok) {
    if (options.cleanWhenUnavailable !== false && existsSync(binDir)) {
      rmSync(binDir, { recursive: true, force: true })
    }
    log(probe.message)
    return {
      built: false,
      skipped: true,
      status: 'unavailable',
      reason: probe.reason,
      minGoVersion: probe.minGoVersion,
      foundGoVersion: probe.foundGoVersion,
      binDir,
      helperPath: join(binDir, 'rtsp-ingest'),
      fixturePath: join(binDir, 'rtspfixture'),
      sha256: undefined,
      message: probe.message,
    }
  }

  mkdirSync(binDir, { recursive: true })
  const outArg = binDir.endsWith('/') ? binDir : `${binDir}/`
  const buildEnv = {
    ...env,
    GOPROXY: 'off',
    GOTOOLCHAIN: 'local',
    GOFLAGS: '-mod=readonly',
    GOWORK: 'off',
  }
  const buildResult = spawnSync(goBin, ['build', '-o', outArg, './cmd/...'], {
    cwd: toolDir,
    encoding: 'utf8',
    env: buildEnv,
  })
  if (buildResult.error || buildResult.status !== 0) {
    const details =
      buildResult.error?.message ||
      buildResult.stderr?.trim() ||
      buildResult.stdout?.trim() ||
      `exit status ${buildResult.status}`
    throw new Error(`rtsp-ingest offline go build failed: ${details}`)
  }
  const suffix = env.GOOS === 'windows' ? '.exe' : ''
  const helperPath = join(binDir, `rtsp-ingest${suffix}`)
  const fixturePath = join(binDir, `rtspfixture${suffix}`)
  if (!existsSync(helperPath)) {
    throw new Error(`rtsp-ingest binary was not created at ${helperPath}`)
  }
  const sha256 = createHash('sha256')
    .update(readFileSync(helperPath))
    .digest('hex')
  const message = `rtsp-ingest built offline with go ${probe.foundGoVersion} into ${binDir} (sha256: ${sha256})`
  log(message)
  return {
    built: true,
    skipped: false,
    status: 'available',
    reason: undefined,
    minGoVersion: probe.minGoVersion,
    foundGoVersion: probe.foundGoVersion,
    binDir,
    helperPath,
    fixturePath,
    sha256,
    message,
  }
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isMain) {
  try {
    buildRtspIngest()
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exit(1)
  }
}
