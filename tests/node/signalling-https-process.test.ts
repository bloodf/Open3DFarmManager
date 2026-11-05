import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import {
  observeFixtureClose,
  waitFixtureClose,
} from '../helpers/signalling-https-process.ts'

test('close receipt waits for inherited output after the parent exits', async () => {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `require('node:child_process').spawn(process.execPath,['-e',"setTimeout(()=>process.stdout.write('drained'),150)"],{stdio:['ignore',1,2]})`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const closed = observeFixtureClose(child)
  let output = ''
  child.stdout!.on('data', (chunk) => (output += chunk.toString()))
  const [code, signal] = await waitFixtureClose(closed, 3000)
  assert.equal(code, 0)
  assert.equal(signal, null)
  assert.equal(output, 'drained')
})

test('failed child drains stderr and timeout leaves cleanup to caller', async () => {
  const child = spawn(
    process.execPath,
    [
      '-e',
      "process.stderr.write('failure');setTimeout(()=>process.exit(7),150)",
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const closed = observeFixtureClose(child)
  let output = ''
  child.stderr!.on('data', (chunk) => (output += chunk.toString()))
  try {
    await assert.rejects(waitFixtureClose(closed, 10), /timed out/)
    const [code] = await waitFixtureClose(closed, 3000)
    assert.equal(code, 7)
    assert.equal(output, 'failure')
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL')
    await waitFixtureClose(closed, 3000)
  }
})
