import { createHash } from 'node:crypto'
import { readAgentRuntimeConfig } from '../config/runtime.ts'
import { readPrivateJson } from '../provisioning/private-fs.ts'
import { canonicalize } from '../../../farm-protocol/src/canonical.ts'

export type ActivationResult =
  'absent' | 'invalid' | 'unchanged' | 'activated' | 'stopped'

export interface RuntimeActivatorOptions {
  runtimeConfigPath: string
  scope: { agent_id: string; farm_id: string }
  /**
   * Starts the existing validated telemetry runtime from the committed file.
   * Must run until `signal` aborts. It is the accepted runtime entry, not a
   * second configuration path.
   */
  start: (signal: AbortSignal) => Promise<void>
  onDiagnostic?: (event: {
    kind: 'runtime-activation'
    result: ActivationResult | 'runtime-exited'
  }) => void
}

/**
 * Supervises the read-only telemetry runtime of a provisioning Connector.
 * A reload validates the committed file with the strict runtime reader first:
 * an invalid or absent file never stops a running runtime. A changed valid
 * file restarts it from that file, so every other printer and section the
 * file holds is preserved exactly.
 */
export function createRuntimeActivator(options: RuntimeActivatorOptions) {
  let running: { controller: AbortController; done: Promise<void> } | null =
    null
  let activeDigest: string | null = null
  let queue: Promise<unknown> = Promise.resolve()
  let stopped = false

  const report = (result: ActivationResult | 'runtime-exited') =>
    options.onDiagnostic?.({ kind: 'runtime-activation', result })

  async function halt(): Promise<void> {
    const current = running
    running = null
    activeDigest = null
    if (!current) return
    current.controller.abort()
    await current.done
  }

  async function reloadNow(): Promise<ActivationResult> {
    if (stopped) return 'stopped'
    let raw: unknown
    try {
      raw = readPrivateJson(options.runtimeConfigPath)
    } catch {
      return 'invalid'
    }
    if (raw === null) return 'absent'
    try {
      readAgentRuntimeConfig(options.runtimeConfigPath, options.scope)
    } catch {
      return 'invalid'
    }
    const digest = createHash('sha256')
      .update(canonicalize(raw))
      .digest('base64url')
    if (running && digest === activeDigest) return 'unchanged'
    await halt()
    if (stopped) return 'stopped'
    const controller = new AbortController()
    const done = Promise.resolve()
      .then(() => options.start(controller.signal))
      .catch(() => undefined)
      .then(() => {
        if (running?.controller === controller && !controller.signal.aborted) {
          running = null
          activeDigest = null
          report('runtime-exited')
        }
      })
    running = { controller, done }
    activeDigest = digest
    return 'activated'
  }

  function serialized<T>(run: () => Promise<T>): Promise<T> {
    const next = queue.then(run, run)
    queue = next.catch(() => undefined)
    return next
  }

  return Object.freeze({
    reload(): Promise<ActivationResult> {
      return serialized(async () => {
        const result = await reloadNow()
        report(result)
        return result
      })
    },
    stop(): Promise<void> {
      stopped = true
      return serialized(halt)
    },
    get active(): boolean {
      return running !== null
    },
  })
}
export type RuntimeActivator = ReturnType<typeof createRuntimeActivator>
