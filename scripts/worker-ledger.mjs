// SPDX-License-Identifier: MIT
import {
  openSync,
  closeSync,
  mkdirSync,
  writeSync,
  constants,
  fchmodSync,
  lstatSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function createWorkerLedger(
  directory = join(homedir(), '.openfarm', 'task-ledger'),
  filename = 'worker-ledger.jsonl',
) {
  let existed = true
  try {
    lstatSync(directory)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    existed = false
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const directoryStat = lstatSync(directory)
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
    throw new Error('Worker ledger directory must be a real directory')
  if (existed && (directoryStat.mode & 0o077) !== 0)
    throw new Error('Existing worker ledger directory is not private')
  const path = join(directory, filename)
  const descriptor = openSync(
    path,
    constants.O_WRONLY |
      constants.O_APPEND |
      constants.O_CREAT |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  )
  try {
    fchmodSync(descriptor, 0o600)
  } catch (error) {
    closeSync(descriptor)
    throw error
  }
  return (data) =>
    writeSync(
      descriptor,
      JSON.stringify({ at: new Date().toISOString(), ...data }) + '\n',
    )
}
