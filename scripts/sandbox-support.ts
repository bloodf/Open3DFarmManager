import { closeSync, openSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function sandboxState(project: string, uid: number, env = process.env) {
  return join(
    env.XDG_STATE_HOME || join(homedir(), '.local', 'state'),
    'open3dfarmmanager',
    `${project}-${uid}`,
  )
}

export function acquireSandboxLock(path: string) {
  const fd = openSync(path, 'wx', 0o600)
  const release = () => {
    process.removeListener('SIGINT', onInt)
    process.removeListener('SIGTERM', onTerm)
    closeSync(fd)
    unlinkSync(path)
  }
  const onSignal = (signal: 'SIGINT' | 'SIGTERM') => {
    release()
    process.kill(process.pid, signal)
  }
  const onInt = () => onSignal('SIGINT')
  const onTerm = () => onSignal('SIGTERM')
  process.once('SIGINT', onInt)
  process.once('SIGTERM', onTerm)
  return release
}
