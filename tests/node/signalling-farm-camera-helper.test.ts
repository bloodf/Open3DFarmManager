import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { helperProcesses } from '../helpers/signalling-farm-camera.ts'
import { createJourneyCameraEncoder } from '../journey/camera-encoder.ts'

const ENCODER_ARGS = [
  '-nostdin',
  '-an',
  '-f',
  'mjpeg',
  '-i',
  'pipe:0',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  '-x264-params',
  'aud=1',
  '-f',
  'h264',
  'pipe:1',
]

async function waitFor(count: () => number, expected: number) {
  const deadline = Date.now() + 5000
  while (count() !== expected && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(count(), expected)
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGKILL')
  await once(child, 'exit')
}

test('the journey stand-in is found by its exact argv[0], not by its Node executable', async () => {
  const encoder = await createJourneyCameraEncoder()
  const child = spawn(encoder.path, ENCODER_ARGS, { stdio: 'pipe' })
  try {
    await waitFor(() => helperProcesses(encoder.path), 1)
    await stop(child)
    await waitFor(() => helperProcesses(encoder.path), 0)
  } finally {
    await stop(child)
    await encoder.dispose()
  }
})

test('a real helper executable is still identified by its executable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'helper-identity-'))
  const helper = join(directory, 'ingest-helper')
  copyFileSync(process.execPath, helper)
  const child = spawn(helper, ['-e', 'setTimeout(() => {}, 30000)'], {
    stdio: 'ignore',
  })
  try {
    await waitFor(() => helperProcesses(helper), 1)
    await stop(child)
    await waitFor(() => helperProcesses(helper), 0)
  } finally {
    await stop(child)
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a plain Node process or a lookalike argv[0] is not counted', async () => {
  if (process.platform !== 'linux') return
  const directory = mkdtempSync(join(tmpdir(), 'helper-identity-'))
  const helper = join(directory, 'ingest-helper')
  const plainNode = spawn(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 30000)', '--', helper],
    { stdio: 'ignore' },
  )
  const spoof = spawn(
    '/bin/bash',
    ['-c', 'exec -a "$0" /bin/sleep 30', helper],
    {
      stdio: 'ignore',
    },
  )
  const prefixed = spawn(
    '/bin/bash',
    [
      '-c',
      `exec -a "$0" ${process.execPath} -e "setTimeout(() => {}, 30000)"`,
      `${helper}-extra`,
    ],
    { stdio: 'ignore' },
  )
  try {
    // Give all three time to exec before asserting absence.
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(helperProcesses(helper), 0)
  } finally {
    await Promise.all([stop(plainNode), stop(spoof), stop(prefixed)])
    rmSync(directory, { recursive: true, force: true })
  }
})
