// SPDX-License-Identifier: MIT
// Hermetic child environment for `npm run desktop:check`: the loopback network
// guard preload, offline package/toolchain settings, and a PATH with every
// Docker executable hidden, so children see Docker as not installed.
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
} from 'node:fs'
import { delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const GUARD_PATH = new URL(
  './desktop-network-guard.mjs',
  import.meta.url,
).pathname
export const GUARD_LOG_ENV = 'OPENFARM_NETWORK_GUARD_LOG'

/** Variables that would select Docker or a bundled/online dependency. */
export const FORBIDDEN_ENV: Readonly<
  Record<string, (value: string) => boolean>
> = {
  OPENFARM_PG: (value) => value === 'docker',
  OPENFARM_SIM: (value) => value === 'docker',
  OPENFARM_BROWSER: (value) => value === 'bundled',
}

export interface Violation {
  readonly at: string
  readonly pid: number
  readonly process: string
  readonly api: string
  readonly target: string
  readonly stack?: string
}

export interface HermeticEnvInput {
  readonly base: NodeJS.ProcessEnv
  readonly logPath: string
  readonly shimDir: string
}

const DOCKER_NAME = /^(docker($|-)|com\.docker\.)/

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * PATH in which no Docker executable resolves. A directory that holds one is
 * replaced by a directory of symlinks to everything else it holds, in the same
 * position, so other tools keep working and `docker` is simply not found.
 */
export function pathWithoutDocker(pathValue: string, shimDir: string): string {
  mkdirSync(shimDir, { recursive: true, mode: 0o700 })
  return pathValue
    .split(delimiter)
    .filter(Boolean)
    .map((dir, index) => {
      let names: string[]
      try {
        names = readdirSync(dir)
      } catch {
        return dir
      }
      const docker = names.filter(
        (name) => DOCKER_NAME.test(name) && isExecutable(join(dir, name)),
      )
      if (docker.length === 0) return dir
      const filtered = join(shimDir, `path-${index}`)
      mkdirSync(filtered, { recursive: true, mode: 0o700 })
      for (const name of names)
        if (!DOCKER_NAME.test(name))
          try {
            symlinkSync(join(dir, name), join(filtered, name))
          } catch {
            // Entry already linked or unreadable; the tool is simply absent.
          }
      return filtered
    })
    .join(delimiter)
}

/** Child environment: guard preload on every Node process, offline everything. */
export function buildHermeticEnv(input: HermeticEnvInput): NodeJS.ProcessEnv {
  const { base, logPath, shimDir } = input
  const preload = `--import=${pathToFileURL(GUARD_PATH).href}`
  const existing = (base.NODE_OPTIONS ?? '')
    .split(/\s+/)
    .filter((option) => option && option !== preload)
  const env: NodeJS.ProcessEnv = {
    ...base,
    NODE_OPTIONS: [...existing, preload].join(' '),
    [GUARD_LOG_ENV]: logPath,
    // Helpers that start their own clean-NODE_OPTIONS children pass this on.
    OPENFARM_NETWORK_GUARD_PRELOAD: preload,
    // Desktops are slower than CI: scale Playwright timeouts (not assertions).
    OPENFARM_TIMEOUT_SCALE: base.OPENFARM_TIMEOUT_SCALE ?? '3',
    npm_config_offline: 'true',
    GOPROXY: 'off',
    GOTOOLCHAIN: 'local',
    PLAYWRIGHT_BROWSERS_PATH: '/nonexistent',
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
    PATH: pathWithoutDocker(base.PATH ?? '', shimDir),
  }
  for (const name of Object.keys(FORBIDDEN_ENV)) delete env[name]
  return env
}

/** Names of forbidden variables set in `env` to a value that selects Docker or bundled downloads. */
export function forbiddenSettings(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(FORBIDDEN_ENV)
    .filter(([name, bad]) => {
      const value = env[name]
      return value !== undefined && bad(value)
    })
    .map(([name]) => `${name}=${env[name]}`)
}

/** Reads every violation recorded so far. Malformed lines are kept, not dropped. */
export function readViolations(logPath: string): Violation[] {
  if (!existsSync(logPath)) return []
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Violation
      } catch {
        return {
          at: '',
          pid: 0,
          process: 'unknown',
          api: 'unparsed-guard-line',
          target: line.slice(0, 200),
        }
      }
    })
}
