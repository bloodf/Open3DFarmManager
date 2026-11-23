// Command helpers for run-polish-docker.mjs: recorded child processes and the
// set of containers the runner owns, so cleanup removes exactly those.
import { execFileSync } from 'node:child_process'

export function createDocker({ root, env, commands }) {
  const containers = new Set()
  const run = (command, args, options = {}) => {
    commands.push([command, ...args].join(' '))
    return execFileSync(command, args, {
      cwd: root,
      stdio: 'inherit',
      env,
      ...options,
    })
  }
  const read = (command, args, options = {}) =>
    run(command, args, { stdio: ['ignore', 'pipe', 'inherit'], ...options })
      .toString()
      .trim()
  const docker = (args, options) => run('docker', args, options)
  return { run, read, docker, containers }
}
