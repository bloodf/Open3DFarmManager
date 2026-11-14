import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
type Native =
  typeof import('../../packages/connector/node_modules/node-datachannel')
const native: Native = createRequire(
  new URL('../../packages/connector/package.json', import.meta.url),
)('node-datachannel')
const { PeerConnection } = native
type DataChannel = ReturnType<
  InstanceType<Native['PeerConnection']>['createDataChannel']
>
import {
  controlDtlsFingerprint,
  controlSdpHash,
} from '../../packages/farm-protocol/src/control-session-binding.ts'
import {
  encodeConfigurationSessionProof,
  signConfigurationSessionProof,
} from '../../packages/farm-protocol/src/configuration-binding.ts'
import {
  decodeConfigurationResponse,
  encodeConfigurationRequest,
  type ConfigurationResponseFrame,
} from '../../packages/farm-protocol/src/configuration-frames.ts'
import { deriveConfigurationAssignmentIdentity } from '../../packages/farm-protocol/src/configuration-inventory.ts'
import {
  decodeConfigurationReceipt,
  type SignedConfigurationReceipt,
} from '../../packages/farm-protocol/src/configuration-receipt.ts'
import type { ConfigurationRuntime } from '../../packages/connector/src/runtime/configuration.ts'
import {
  decodeConnectorChannelMessage,
  encodeBrowserChannelMessage,
} from '../../packages/connector/src/webrtc/configuration-channel.ts'
import { ConfigurationConnectorPeer } from '../../packages/connector/src/webrtc/configuration-peer.ts'
import {
  AUDIENCE,
  FARM_ORIGIN,
  browserKey,
  commitFrame,
  createWorld,
  nonce,
  prepareFrame,
  statusFrame,
  type World,
} from '../helpers/configuration-inventory-world.ts'

/*
 * Real loopback node-datachannel transport between the Connector peer and a
 * native peer playing the browser, through the exported runtime, session,
 * authority, engine, activator and issuer source. MOCK-ONLY boundaries: the
 * KobraLink service, the farm server's signing and the HTTPS issuer fetch. No
 * external network, no printer, no shared engine.
 */
type Browser = Awaited<ReturnType<typeof browserKey>>

async function connect(
  w: World,
  runtime: ConfigurationRuntime,
  browser: Browser,
  over: Record<string, unknown> = {},
) {
  const transportId = randomUUID()
  const connectorNonce = nonce()
  const credentialJti = (over.credential_jti as string | undefined) ?? w.ids.jti
  let resolveBinding: (value: unknown) => void = () => {}
  const bindingPromise = new Promise<unknown>((resolve) => {
    resolveBinding = resolve
  })
  const peer = new ConfigurationConnectorPeer({
    bindAddress: '127.0.0.1',
    binding: bindingPromise,
    session: (send) =>
      runtime.openSession({
        expected: {
          transportId,
          farmId: w.ids.farm,
          agentId: w.ids.agent,
          accountId: 'account_owner',
          keyId: w.ids.key,
          browserThumbprint: browser.thumbprint,
          credentialJti,
          connectorNonce,
        },
        send,
      }),
  })
  const offer = await peer.offer()
  const browserPeer = new PeerConnection('browser', {
    iceServers: [],
    bindAddress: '127.0.0.1',
    enableIceTcp: false,
  })
  let gathered: () => void = () => {}
  const gathering = new Promise<void>((resolve) => {
    gathered = resolve
  })
  browserPeer.onGatheringStateChange((state) => {
    if (state === 'complete') gathered()
  })
  const inbox: ReturnType<typeof decodeConnectorChannelMessage>[] = []
  let wake: () => void = () => {}
  let channel: DataChannel | undefined
  const opened = new Promise<void>((resolve) => {
    browserPeer.onDataChannel((incoming) => {
      channel = incoming
      incoming.onMessage((raw) => {
        inbox.push(decodeConnectorChannelMessage(String(raw)))
        wake()
      })
      resolve()
    })
  })
  browserPeer.setRemoteDescription(offer, 'offer')
  await gathering
  const answer = browserPeer.localDescription()!.sdp
  peer.answer(answer)
  const binding = {
    v: 1,
    purpose: 'configuration-rtc',
    protocol: 'config-v1',
    transport_id: transportId,
    farm_id: w.ids.farm,
    agent_id: w.ids.agent,
    account_id: 'account_owner',
    key_id: w.ids.key,
    browser_public_key: browser.publicKey,
    browser_thumbprint: browser.thumbprint,
    connector_public_key_spki: w.identity.publicKeySpki,
    connector_fingerprint: w.identity.fingerprint,
    credential_jti: credentialJti,
    origin: FARM_ORIGIN,
    audience: AUDIENCE,
    browser_nonce: nonce(),
    connector_nonce: connectorNonce,
    issued_at: w.env.now,
    expires_at: w.env.now + 30_000,
    offer_sha256: await controlSdpHash(offer),
    answer_sha256: await controlSdpHash(answer),
    browser_dtls: controlDtlsFingerprint(answer),
    connector_dtls: controlDtlsFingerprint(offer),
  }
  resolveBinding(binding)
  const next = async (ms = 5000) => {
    const end = Date.now() + ms
    while (
      inbox.length === 0 &&
      Date.now() < end &&
      !peer.diagnostics().terminal
    )
      await new Promise<void>((resolve) => {
        wake = resolve
        setTimeout(resolve, 20)
      })
    return inbox.shift()
  }
  const send = (message: unknown) =>
    channel!.sendMessage(encodeBrowserChannelMessage(message))
  await opened
  assert.equal((await next())?.t, 'proof')
  send({
    v: 1,
    t: 'proof',
    proof: encodeConfigurationSessionProof({
      v: 1,
      role: 'browser',
      binding: binding as never,
      signature: await signConfigurationSessionProof(
        binding as never,
        'browser',
        browser.pair.privateKey,
      ),
    }),
  })
  for (let i = 0; i < 200 && peer.session.state !== 'authenticated'; i++)
    await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(peer.session.state, 'authenticated')
  return {
    peer,
    offer,
    answer,
    binding: binding as never,
    async request(
      frame: Record<string, unknown>,
    ): Promise<ConfigurationResponseFrame> {
      const auth = await w.authorize(browser, binding as never, frame)
      send({
        v: 1,
        t: 'request',
        frame: encodeConfigurationRequest(frame),
        ...auth,
      })
      const message = await next()
      assert.equal(message?.t, 'response')
      if (message?.t !== 'response') throw new Error('no response')
      return decodeConfigurationResponse(message.frame)
    },
    async inventory(receipt: SignedConfigurationReceipt, attestation?: string) {
      const wire =
        attestation ?? (await w.ack({ binding: binding as never }, receipt))
      channel!.sendMessage(await w.inventoryMessage(receipt, wire))
      const message = await next()
      assert.equal(message?.t, 'inventory-result')
      if (message?.t !== 'inventory-result') throw new Error('no result')
      return message
    },
    close() {
      peer.close('test-done')
      try {
        channel?.close()
      } catch {}
      browserPeer.close()
    },
  }
}

async function until(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms
  while (!check() && Date.now() < end)
    await new Promise((resolve) => setTimeout(resolve, 20))
}

function receiptOf(response: ConfigurationResponseFrame) {
  assert.equal(response.type, 'result')
  if (response.type !== 'result') throw new Error('not a result')
  return response.receipt
}

test('real loopback RTC: no early activation, existing collector continuity, fresh-session confirmation after restart', async () => {
  const w = await createWorld({ moonraker: true })
  w.env.now = Date.now()
  const browser = await browserKey()
  const connections: Awaited<ReturnType<typeof connect>>[] = []
  try {
    const first = w.boot()
    await first.start()
    assert.deepEqual(w.env.collected, [['voron']])
    const a = await connect(w, first, browser)
    connections.push(a)
    // Complete SDP gathering in both peers: every candidate is inside the
    // descriptions the binding pins, so no trickle candidate is ever needed.
    for (const description of [a.offer, a.answer]) {
      assert.match(description, /^a=candidate:/m)
      assert.match(description, /^m=application /m)
      assert.doesNotMatch(description, / typ relay/)
    }
    const op = randomUUID()
    const prepared = await a.request(prepareFrame(op))
    assert.equal(prepared.type === 'result' && prepared.state, 'prepared')
    const committed = await a.request(await commitFrame(op, prepared))
    assert.equal(
      committed.type === 'result' && committed.state,
      'local-committed',
    )
    const receipt = receiptOf(committed)
    // Local commit alone: file holds both, collector snapshot only Moonraker.
    assert.equal(w.readRuntimeFile().assignments.length, 2)
    assert.equal(w.env.starts, 1)
    assert.equal(w.env.stops, 0)

    // The ack is lost; the Connector restarts with the pending local commit.
    a.close()
    await a.peer.closed
    await first.shutdown()
    assert.equal(w.env.stops, 1)
    const second = w.boot()
    assert.deepEqual(await second.start(), { pendingInventory: 1 })
    assert.deepEqual(w.env.collected.at(-1), ['voron'])

    const b = await connect(w, second, browser)
    connections.push(b)
    // Ack alone, without fresh admission on this transport: refused.
    const refused = await b.inventory(receipt)
    assert.equal(refused.ok, false)
    assert.equal(refused.reason, 'rejected')
    assert.equal(w.env.starts, 2)
    // Fresh status authority, then the newly issued signed ack.
    const status = await b.request(await statusFrame(op))
    assert.equal(receiptOf(status).receipt_id, receipt.receipt_id)
    const confirmed = await b.inventory(receipt)
    assert.equal(confirmed.ok, true)
    assert.equal(
      decodeConfigurationReceipt(confirmed.receipt!).phase,
      'inventory-confirmed',
    )
    const canonical = await deriveConfigurationAssignmentIdentity({
      account_id: 'account_owner',
      farm_id: w.ids.farm,
      agent_id: w.ids.agent,
      bridge_instance_id: receipt.target.bridge_instance_id,
      device_id: receipt.target.device_id,
    })
    const stored = w.readRuntimeFile().assignments[1]
    assert.equal(stored.assignment_id, canonical.assignment_id)
    assert.equal(stored.printer_key, canonical.printer_key)
    assert.equal(
      w.readRuntimeFile().assignments[0].assignment_id,
      w.moonrakerId,
    )
    assert.deepEqual(
      w.env.collected.at(-1),
      ['voron', canonical.printer_key].sort(),
    )
    assert.equal(w.env.starts, 3)
    assert.equal(w.bridge.state.creates, 1)

    // Shutdown closes the real transport and stops the collector.
    await second.shutdown()
    await until(() => b.peer.diagnostics().terminal !== null)
    assert.notEqual(b.peer.diagnostics().terminal, null)
    assert.equal(b.peer.session.state, 'closed')
    assert.equal(second.diagnostics().openTransports, 0)
    assert.equal(w.env.stops, w.env.starts)
  } finally {
    for (const connection of connections) {
      connection.close()
      await connection.peer.closed
    }
    await w.cleanup()
  }
})
