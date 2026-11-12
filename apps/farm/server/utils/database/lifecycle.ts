import {
  assertSameDatabaseTargets,
  parseDatabaseRuntimeConfig,
  startDatabaseRuntime,
  type DatabaseRuntimeConfig,
} from './runtime.ts'
import { databasePhase, setDatabasePhase } from './phase.ts'
import { DatabaseStartupError, STARTUP_FAILURE_MESSAGES } from './schema.ts'

type Deps = {
  start: (config: DatabaseRuntimeConfig) => Promise<void>
  exit: (code: number) => void
  log: (message: string) => void
}
const defaults: Deps = {
  start: startDatabaseRuntime,
  exit: (code) => process.exit(code),
  log: (message) => console.error(message),
}

/** The synchronous part (phase 'starting') must run before Nitro listens, because
 * pinned Nitro does not await plugins. The returned promise settles the phase. */
export function beginDatabaseStartup(
  root: unknown,
  deps: Deps = defaults,
): Promise<void> | undefined {
  function fail(error: unknown) {
    // A failure caused by shutdown is not a startup failure.
    if (databasePhase() !== 'starting') return
    setDatabasePhase('failed')
    const code =
      error instanceof DatabaseStartupError ? error.code : 'unreachable'
    deps.log(
      `Database startup failed: ${STARTUP_FAILURE_MESSAGES[code]}; refusing to serve`,
    )
    deps.exit(1)
  }
  let config: DatabaseRuntimeConfig | undefined
  try {
    config = parseDatabaseRuntimeConfig(
      typeof root === 'object' && root
        ? Reflect.get(root, 'database')
        : undefined,
    )
    if (config) assertSameDatabaseTargets(config, root)
  } catch (error) {
    setDatabasePhase('starting')
    fail(error)
    return undefined
  }
  if (!config) return undefined
  setDatabasePhase('starting')
  return deps.start(config).then(() => {
    if (databasePhase() === 'starting') setDatabasePhase('ready')
  }, fail)
}
