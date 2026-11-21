import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import test from 'node:test'
import { encodeConfigurationSignallingServerFrame } from '../../packages/farm-protocol/src/configuration-signalling.ts'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import type { ConfigurationSocket } from '../../packages/connector/src/webrtc/configuration-signalling.ts'
import { createConfigurationSignallingClient } from '../../packages/connector/src/webrtc/configuration-signalling.ts'

test('closing after config.retry clears its timer without another send', async () => {
  const id = randomUUID()
  const identity = new ConnectorIdentity(generateKeyPairSync('ed25519').privateKey)
  const sent: string[] = []
  let handlers: { message(raw: unknown): void; close(): void } | undefined
  let closed = false
  const socket: ConfigurationSocket = {
    send(wire) {
      if (closed) throw new Error('Configuration socket closed')
      sent.push(wire)
    },
    close() {
      closed = true
      handlers?.close()
    },
    bind(value) { handlers = value },
  }
  const client = createConfigurationSignallingClient({
    identity,
    farmOrigin: 'https://farm.example.com',
    credentialAudience: 'open3dfarm/connector',
    farmId: randomUUID(),
    agentId: randomUUID(),
    credential: () => ({ token: 'a.b.c', jti: id }),
    runtime: () => ({ revision: () => 0, revokeAll() {}, openSession() { throw new Error('unused') } }) as never,
    socket: async () => socket,
    retryMinMs: 60_000,
  })
  const controller = new AbortController()
  const running = client.run(controller.signal)
  for (let i = 0; i < 100 && sent.length === 0; i++)
    await new Promise((resolve) => setTimeout(resolve, 2))
  assert.equal(sent.length, 1)
  handlers?.message(encodeConfigurationSignallingServerFrame({
    v: 1, t: 'config.retry', retry_after_ms: 25,
  }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  handlers?.close()
  const sendsAtClose = sent.length
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(sent.length, sendsAtClose)
  controller.abort()
  await running
})
