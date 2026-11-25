// SPDX-License-Identifier: MIT
// Shared rules for Docker test runners:
//
//   * writable host paths live under ${XDG_CACHE_HOME:-$HOME/.cache}/openfarm-docker/<run-id>
//     and that run directory is removed after the run;
//   * containers are always `--rm`;
//   * an interruption waits for any in-flight `docker create` to return its id
//     before cleaning up, so no container is orphaned.
import { spawn } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

export function runRoot(env = process.env) {
  return resolve(
    env.XDG_CACHE_HOME || join(env.HOME || homedir(), '.cache'),
    'openfarm-docker',
  )
}

export function createRunDir(prefix, env = process.env) {
  const root = runRoot(env)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  return mkdtempSync(join(root, `${prefix}-`))
}

/** tmpfs for /tmp: Docker's default options would forbid executing from it. */
export const TMPFS_TMP = '/tmp:rw,exec,mode=1777'

/** The `docker create` form of a `docker run` argv, so the id is known before start. */
export function asCreate(runArgs) {
  if (runArgs[0] !== 'run' || !runArgs.includes('--rm'))
    throw new Error('Expected a `docker run --rm` argv')
  return ['create', ...runArgs.slice(1)]
}

/** Violations of the run-directory rules in one `docker run`/`create` argv. */
export function findRunArgvProblems(args, runDir) {
  const problems = []
  const inside = (source) =>
    resolve(source) === source &&
    (source === runDir || source.startsWith(runDir + sep))
  if (!['run', 'create'].includes(args[0]))
    problems.push(`not a run/create argv: ${args[0]}`)
  if (!args.includes('--rm')) problems.push('missing --rm')
  if (/\bnpm\s+(ci|install|i)\b/.test(args.join(' ')))
    problems.push('installs dependencies inside the container')
  args.forEach((arg, index) => {
    const next = String(args[index + 1])
    if (arg === '-v' || arg === '--volume') {
      if (!inside(next.split(':')[0]))
        problems.push(`mount outside the run directory: ${next}`)
    } else if (arg === '--mount') {
      const fields = next.split(',')
      const field = (...keys) =>
        fields
          .map((entry) => entry.split('='))
          .find(([key]) => keys.includes(key))?.[1]
      const type = field('type')
      const readonly = fields.includes('readonly')
      const ok =
        type === 'tmpfs' ||
        (type === 'image' && readonly) ||
        (type === 'bind' && inside(field('source', 'src') ?? ''))
      if (!ok) problems.push(`mount outside the run directory: ${next}`)
    } else if (/^(--volume=|--mount=|-v=|--volumes-from)/.test(arg))
      problems.push(`unsupported mount form: ${arg}`)
    else if (
      arg === '--network=host' ||
      (arg === '--network' && next === 'host')
    )
      problems.push('host network')
  })
  return problems
}

/**
 * Run one Docker CLI command. `detached` puts the CLI in its own process group,
 * so a terminal Ctrl-C cannot kill it before it reports the container id.
 */
export function execDocker(
  bin,
  args,
  {
    detached = false,
    inherit = false,
    onOutput,
    timeout,
    spawnImpl = spawn,
  } = {},
) {
  return new Promise((done) => {
    const child = spawnImpl(bin, args, {
      detached,
      stdio: inherit
        ? ['ignore', 'inherit', 'inherit']
        : ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = timeout
      ? setTimeout(() => {
          timedOut = true
          child.kill('SIGKILL')
        }, timeout)
      : undefined
    const collect = (stream, add) =>
      stream?.on('data', (chunk) => {
        add(String(chunk))
        onOutput?.(chunk)
      })
    collect(child.stdout, (text) => (stdout += text))
    collect(child.stderr, (text) => (stderr += text))
    const finish = (status, error) => {
      clearTimeout(timer)
      done({
        status,
        stdout,
        stderr,
        error: timedOut
          ? Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })
          : error,
      })
    }
    child.on('error', (error) => finish(127, error))
    child.on('close', (status) => finish(status ?? 1))
  })
}

/** Keep a service container's output, which `--rm` would otherwise discard. */
export function followLogs(id, bin = 'docker') {
  let text = ''
  const child = spawn(bin, ['logs', '--follow', id], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const add = (chunk) => (text = (text + chunk).slice(-64 * 1024))
  child.stdout.on('data', add)
  child.stderr.on('data', add)
  child.on('error', add)
  child.unref()
  child.stdout.unref?.()
  child.stderr.unref?.()
  return () => text
}

/**
 * Containers owned by one runner. `exec` is injectable for tests and has the
 * shape of `execDocker` without the binary argument.
 */
export function createLifecycle({
  bin = 'docker',
  exec = (args, options) => execDocker(bin, args, options),
  log = console.error,
} = {}) {
  const containers = new Set()
  const pending = new Set()
  const finalizers = []
  let closing = false
  let cleaning

  const refuseWhenClosing = () => {
    if (closing) throw new Error('Interrupted: no new containers are started')
  }

  /** `docker create`; the container is owned as soon as its id is returned. */
  async function create(args) {
    refuseWhenClosing()
    const task = exec(args, { detached: true }).then((result) => {
      if (result.status !== 0)
        throw new Error(`docker create failed: ${result.stderr.trim()}`)
      const id = result.stdout.trim().split('\n').at(-1)
      containers.add(id)
      return id
    })
    pending.add(task)
    try {
      return await task
    } finally {
      pending.delete(task)
    }
  }

  async function remove(id) {
    const result = await exec(['rm', '-f', '-v', id], { detached: true })
    if (result.status !== 0) {
      if (/removal of container .* is already in progress/i.test(result.stderr))
        await exec(['wait', id], { detached: true, timeout: 30_000 })
      else if (!/no such container/i.test(result.stderr)) {
        log(`Could not remove container ${id}: ${result.stderr.trim()}`)
        return false
      }
    }
    containers.delete(id)
    return true
  }

  /** Foreground `docker run --rm`, split so the id exists before it starts. */
  async function run(runArgs, options = {}) {
    const id = await create(asCreate(runArgs))
    refuseWhenClosing()
    const result = await exec(['start', '--attach', id], {
      ...options,
      detached: true,
    })
    await remove(id)
    return result
  }

  /** Refuse new containers and wait for in-flight creates. */
  async function settle() {
    closing = true
    await Promise.allSettled([...pending])
  }

  /** Remove every owned container, then run finalizers (last added first). */
  function cleanup() {
    return (cleaning ??= (async () => {
      await settle()
      const failures = []
      for (const id of [...containers])
        if (!(await remove(id))) failures.push(id)
      for (const finalize of finalizers.reverse()) {
        try {
          await finalize()
        } catch (error) {
          failures.push(error.message)
          log(`Cleanup step failed: ${error.message}`)
        }
      }
      return failures
    })())
  }

  function installSignals(target = process) {
    for (const [signal, code] of [
      ['SIGINT', 130],
      ['SIGTERM', 143],
    ])
      target.on(signal, async () => {
        await cleanup()
        target.exit(code)
      })
  }

  return {
    create,
    run,
    remove,
    settle,
    cleanup,
    installSignals,
    finalizer: (fn) => finalizers.push(fn),
    exec: (args, options) => exec(args, options),
    containers,
  }
}

/**
 * Delete a run directory. Containers may leave files owned by another uid; those
 * are emptied by a `--rm` container that mounts only this directory.
 */
export async function removeRunDir(
  runDir,
  { image, bin = 'docker', env = process.env } = {},
) {
  if (dirname(runDir) !== runRoot(env))
    throw new Error(
      `Refusing to remove a directory outside the runs: ${runDir}`,
    )
  try {
    rmSync(runDir, { recursive: true, force: true })
    return
  } catch (error) {
    if (!image) throw error
  }
  await execDocker(bin, purgeArgs(runDir, image), {
    detached: true,
    inherit: true,
  })
  rmSync(runDir, { recursive: true, force: true })
}

export function purgeArgs(runDir, image) {
  return [
    ...['run', '--rm', '--pull=never', '--network', 'none', '--user', '0'],
    ...['--entrypoint', 'find', '-v', `${runDir}:/run-dir`, image],
    ...['/run-dir', '-mindepth', '1', '-delete'],
  ]
}

/** Copy the listed workspace files (relative to `root`) into `destination`. */
export function copyWorkspace(root, files, destination) {
  mkdirSync(destination, { recursive: true })
  for (const file of files) {
    const target = join(destination, file)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(join(root, file), target, {
      recursive: true,
      verbatimSymlinks: true,
    })
  }
}

/** The environment smokes of the check image (infra/check/Dockerfile). */
export function checkImageRunArgs({ name, image, env = [], command }) {
  return [
    ...['run', '--rm', '--name', name],
    ...['--network', 'none', '--shm-size', '1g'],
    // /workspace stays the image's own source snapshot, discarded by --rm.
    ...['--tmpfs', TMPFS_TMP],
    ...['--tmpfs', '/home/node:rw,exec,uid=1000,gid=1000,mode=0755'],
    ...env.flatMap((entry) => ['--env', entry]),
    image,
    ...command,
  ]
}
