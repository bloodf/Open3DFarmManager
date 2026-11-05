import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { test } from 'node:test'
import { serveProxyDisconnect } from '../helpers/signalling-https-disconnect-ipc.ts'

const helper = new URL(
  '../helpers/signalling-https-disconnect-ipc.ts',
  import.meta.url,
).href
function childFor(script: string) {
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '-e', script],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  )
  child.stdout?.resume()
  child.stderr?.resume()
  return child
}
async function closed(child: ReturnType<typeof childFor>, timeout = 3000) {
  try {
    return await Promise.race([
      once(child, 'close'),
      new Promise<never>((_, reject) => {
        const t = setTimeout(
          () => reject(new Error('child timed out')),
          timeout,
        )
        t.unref()
      }),
    ])
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL')
  }
}

test('IPC waits for owned proxy disconnection before acknowledging', async () => {
  const child = childFor(
    `import {requestProxyDisconnect} from ${JSON.stringify(helper)}; await requestProxyDisconnect(); process.disconnect()`,
  )
  let called = false
  serveProxyDisconnect(child, async () => {
    await new Promise((resolve) => setTimeout(resolve, 40))
    called = true
  })
  assert.equal((await closed(child))[0], 0)
  assert.equal(called, true)
})

test('IPC rejects invalid and duplicate parent requests', async () => {
  for (const body of [
    "{kind:'unknown',id:'bad'}",
    "{kind:'upgrade-drop',id:'00000000-0000-0000-0000-000000000000'}",
  ]) {
    const child = childFor(
      `process.send(${body}); process.send(${body}); setTimeout(()=>process.exit(0),1000)`,
    )
    serveProxyDisconnect(
      child,
      () => new Promise((resolve) => setTimeout(resolve, 200)),
    )
    const [, signal] = await closed(child)
    assert.equal(signal, 'SIGTERM')
  }
})

test('IPC requester rejects a malformed reply', async () => {
  const child = childFor(
    `import {requestProxyDisconnect} from ${JSON.stringify(helper)}; try {await requestProxyDisconnect(); process.exitCode=2} catch {if(process.connected) process.disconnect()}`,
  )
  child.once('message', () => child.send!({ kind: 'wrong' }))
  assert.equal((await closed(child))[0], 0)
})

test('IPC requester rejects when the parent disconnects', async () => {
  const child = childFor(
    `import {requestProxyDisconnect} from ${JSON.stringify(helper)}; try {await requestProxyDisconnect(); process.exit(2)} catch (error) {process.exit(error?.message === 'Fixture IPC disconnected' ? 0 : 3)}`,
  )
  child.once('message', () => child.disconnect())
  try {
    assert.equal((await once(child, 'exit'))[0], 0)
  } finally {
    child.stdout?.destroy()
    child.stderr?.destroy()
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL')
  }
})

test('failed proxy drop terminates the requesting child', async () => {
  const child = childFor(
    `import {requestProxyDisconnect} from ${JSON.stringify(helper)}; await requestProxyDisconnect()`,
  )
  serveProxyDisconnect(child, async () => {
    throw new Error('synthetic failure')
  })
  const [, signal] = await closed(child)
  assert.equal(signal, 'SIGTERM')
})

test('duplicate response closes the channel and rejects later requests', async () => {
  const child = childFor(
    `import {requestProxyDisconnect} from ${JSON.stringify(helper)}; await requestProxyDisconnect(); await new Promise(r=>setTimeout(r,40)); try {await requestProxyDisconnect(); process.exitCode=2} catch {if(process.connected) process.disconnect()}`,
  )
  child.once('message', (value) => {
    const response = {
      kind: 'upgrade-drop-result',
      id: (value as { id: string }).id,
      ok: true,
    }
    child.send!(response)
    child.send!(response)
  })
  assert.equal((await closed(child))[0], 0)
})

test('proxy drop waits for tracked stream close and rejects an empty set', async () => {
  const { PassThrough } = await import('node:stream')
  const { disconnectFixtureUpgrades } = await import(
    '../helpers/signalling-https-proxy.ts'
  )
  const first = new PassThrough(),
    second = new PassThrough()
  const tracked = new Set([first, second])
  await disconnectFixtureUpgrades(tracked)
  assert.equal(first.destroyed, true)
  assert.equal(second.destroyed, true)
  await assert.rejects(disconnectFixtureUpgrades(new Set()), /No active/)
})

test('IPC requester times out if no acknowledgement arrives', async () => {
  const child = childFor(
    `import {requestProxyDisconnect} from ${JSON.stringify(helper)}; try {await requestProxyDisconnect(); process.exitCode=2} catch {if(process.connected) process.disconnect()}`,
  )
  child.on('message', () => {})
  assert.equal((await closed(child, 7000))[0], 0)
})
