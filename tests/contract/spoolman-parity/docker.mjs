// Docker helpers for the Spoolman parity harness. Only local Docker is used.
// Every container is created with the harness label and removed (with its
// anonymous volumes) when the run ends, whatever the outcome.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export const OWNER_LABEL = 'org.open3dfarmmanager.task'
export const TASK = 'spoolman-parity-546'

export async function docker(...args) {
  const { stdout } = await exec('docker', args, {
    timeout: 600_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  return stdout.trim()
}

/**
 * Make sure `reference` (always `name@sha256:...`) exists locally, pulling it by
 * digest when it does not. A failed pull stops the run with a clear message.
 */
export async function ensureImage(reference, purpose) {
  if (!/^[a-z0-9./_-]+(?::[\w.-]+)?@sha256:[a-f0-9]{64}$/.test(reference))
    throw new Error(`${purpose}: image must be pinned by digest: ${reference}`)
  try {
    await docker('image', 'inspect', '--format', '{{.Id}}', reference)
    return 'local'
  } catch {
    // not present: pull below
  }
  try {
    await docker('pull', '--quiet', reference)
    return 'pulled'
  } catch (error) {
    throw new Error(
      `${purpose}: cannot pull ${reference}. Docker must be able to reach the registry once ` +
        `(or the image must already be present locally): ${String(error.stderr ?? error.message).split('\n')[0]}`,
    )
  }
}

/** Force-remove every container this process created; verify none remain. */
export async function removeContainers(names) {
  const remaining = []
  for (const name of names) {
    try {
      const label = await docker(
        'inspect',
        '--format',
        `{{index .Config.Labels "${OWNER_LABEL}"}}`,
        name,
      )
      if (label !== TASK) {
        remaining.push(`${name} (foreign label, left alone)`)
        continue
      }
      await docker('rm', '-f', '-v', name)
    } catch (error) {
      if (!/no such (object|container)/i.test(String(error.stderr ?? error)))
        remaining.push(
          `${name}: ${String(error.stderr ?? error).split('\n')[0]}`,
        )
    }
  }
  return remaining
}
