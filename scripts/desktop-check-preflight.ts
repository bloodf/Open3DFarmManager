// SPDX-License-Identifier: MIT
// Preflight for `npm run desktop:check`: prints the toolchain it will use and
// fails when something the offline desktop run needs is missing or when Docker
// would be used.
import { execFileSync } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { probeGoToolchain } from './build-rtsp-ingest.mjs'
import { forbiddenSettings } from './desktop-network-env.ts'
import { assertBambuCloudOff } from '../packages/connector/src/bambu/cloud.ts'
import {
  MIN_SUPPORTED_NODE_VERSION,
  isSupportedNodeVersion,
} from '../tests/helpers/node-version.ts'
import { findPostgresBin } from '../tests/helpers/disposable-postgres.ts'

export interface PreflightReport {
  readonly versions: Readonly<Record<string, string>>
  readonly failures: readonly string[]
  readonly notes: readonly string[]
  /** Go is present and new enough for the optional rtsp-ingest build. */
  readonly goAvailable: boolean
  /** Extra child environment, such as the Chrome path that was found. */
  readonly env: Readonly<Record<string, string>>
}

const MIN_POSTGRES_MAJOR = 13

function run(command: string, args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync(command, args, {
    encoding: 'utf8',
    env,
    timeout: 20_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function onPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir && executable(join(dir, name))) return join(dir, name)
  }
  return undefined
}

/** Chrome the Playwright `chrome` channel (or OPENFARM_CHROME_PATH) will launch. */
export function findChrome(env: NodeJS.ProcessEnv): string | undefined {
  const explicit = env.OPENFARM_CHROME_PATH?.trim()
  if (explicit) return executable(explicit) ? explicit : undefined
  const standard = [
    '/opt/google/chrome/chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find(executable)
  if (standard) return standard
  for (const name of ['google-chrome-stable', 'google-chrome', 'chrome']) {
    const found = onPath(name, env)
    if (found) return found
  }
  return undefined
}

/** `docker` binary reachable on PATH; informational, it is never used. */
export function dockerOnPath(env: NodeJS.ProcessEnv): string | undefined {
  return onPath('docker', env)
}

export function preflight(env: NodeJS.ProcessEnv): PreflightReport {
  const versions: Record<string, string> = {}
  const failures: string[] = []
  const notes: string[] = []
  const extraEnv: Record<string, string> = {}

  versions.node = process.version
  if (!isSupportedNodeVersion(process.version))
    failures.push(
      `Node ${process.version}: Node >=${MIN_SUPPORTED_NODE_VERSION} <25 is required`,
    )

  try {
    versions.npm = run('npm', ['--version'], env)
  } catch (error) {
    failures.push(
      `npm not available: ${(error as Error).message.split('\n')[0]}`,
    )
  }

  const chrome = findChrome(env)
  if (!chrome) {
    failures.push(
      'Google Chrome not found (install it or set OPENFARM_CHROME_PATH); bundled browsers are not available offline',
    )
  } else {
    try {
      versions.chrome = run(chrome, ['--version'], env)
    } catch {
      versions.chrome = `${chrome} (version unreadable)`
    }
    if (
      !env.OPENFARM_CHROME_PATH &&
      !chrome.startsWith('/opt/google/') &&
      !chrome.startsWith('/Applications/')
    )
      extraEnv.OPENFARM_CHROME_PATH = chrome
  }

  try {
    const bins = findPostgresBin(true)
    versions.postgresql = bins.version
    if (bins.majorVersion < MIN_POSTGRES_MAJOR)
      failures.push(
        `${bins.version}: PostgreSQL >= ${MIN_POSTGRES_MAJOR} is required`,
      )
  } catch (error) {
    failures.push((error as Error).message)
  }

  const go = probeGoToolchain({ env })
  if (go.ok) versions.go = `go${go.foundGoVersion}`
  else notes.push(go.message)

  const forbidden = forbiddenSettings(env)
  for (const setting of forbidden)
    failures.push(
      `${setting}: Docker or bundled browsers are not allowed in a desktop run`,
    )
  if (env.DOCKER_HOST)
    failures.push('DOCKER_HOST is set: Docker is not allowed in a desktop run')
  const docker = dockerOnPath(env)
  notes.push(
    docker
      ? `docker found at ${docker}; it is hidden from every step, which sees Docker as not installed`
      : 'docker not on PATH',
  )

  try {
    assertBambuCloudOff(env)
  } catch (error) {
    failures.push((error as Error).message)
  }

  if (!existsSync(new URL('../node_modules', import.meta.url)))
    failures.push(
      'node_modules missing: run `npm ci --offline` from the dependency cache first',
    )

  return { versions, failures, notes, goAvailable: go.ok, env: extraEnv }
}
