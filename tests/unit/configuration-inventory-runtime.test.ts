import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { signConfigurationSessionProof } from '../../packages/farm-protocol/src/configuration-binding.ts'
import { encodeConfigurationSessionProof } from '../../packages/farm-protocol/src/configuration-binding.ts'
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
import {
  FARM_ORIGIN,
  browserKey,
  commitFrame,
  createWorld,
  prepareFrame,
  statusFrame,
  type Browser,
  type World,
} from '../helpers/configuration-inventory-world.ts'

/*
 * Inventory confirmation of the provisioning Connector. Real exported
 * runtime/session/authority/engine/journal/activator/snapshot/runtime reader
 * and the real issuer source (public HTTPS metadata DTO, no auth headers).
 * Synthetic: the KobraLink service, the farm server's signing (accepted
 * farm-protocol helpers, same claims as the server registration) and the
 * transport of the config channel.
 */
const realFetch = globalThis.fetch
let networkAttempts = 0
const worlds: World[] = []
beforeEach(() => {
  networkAttempts = 0
  globalThis.fetch = (async () => {
    networkAttempts++
    throw new Error('real network forbidden')
  }) as typeof fetch
})
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.cleanup()
  globalThis.fetch = realFetch
  expect(networkAttempts).toBe(0)
})
async function world(options: Parameters<typeof createWorld>[0] = {}) {
  const w = await createWorld(options)
  worlds.push(w)
  return w
}

/** One authenticated synthetic config transport. */
async function connect(
  w: World,
  runtime: ConfigurationRuntime,
  browser: Browser,
  over: Record<string, unknown> = {},
  expectedOver: Record<string, unknown> = {},
) {
  const issued = await w.binding(browser, over)
  const b = issued.value as never as Parameters<typeof w.ack>[0]['binding']
  const raw = issued.value as Record<string, unknown>
  const inbox: ReturnType<typeof decodeConnectorChannelMessage>[] = []
  let wake: () => void = () => {}
  const session = runtime.openSession({
    expected: {
      transportId: raw.transport_id as string,
      farmId: w.ids.farm,
      agentId: w.ids.agent,
      accountId: raw.account_id as string,
      keyId: raw.key_id as string,
      browserThumbprint: browser.thumbprint,
      credentialJti: raw.credential_jti as string,
      connectorNonce: raw.connector_nonce as string,
      ...expectedOver,
    },
    send: (wire) => {
      inbox.push(decodeConnectorChannelMessage(wire))
      wake()
    },
  })
  const next = async () => {
    for (let i = 0; i < 300 && inbox.length === 0; i++) {
      if (session.state === 'closed') break
      await new Promise<void>((resolve) => {
        wake = resolve
        setTimeout(resolve, 10)
      })
    }
    return inbox.shift()
  }
  await session.activate(
    raw,
    { localSdp: issued.offer, remoteSdp: issued.answer },
    raw.browser_dtls as string,
  )
  const connectorProof = await next()
  if (connectorProof?.t === 'proof') {
    session.receive(
      encodeBrowserChannelMessage({
        v: 1,
        t: 'proof',
        proof: encodeConfigurationSessionProof({
          v: 1,
          role: 'browser',
          binding: b,
          signature: await signConfigurationSessionProof(
            b,
            'browser',
            browser.pair.privateKey,
          ),
        }),
      }),
    )
    for (let i = 0; i < 200 && session.state !== 'authenticated'; i++)
      await new Promise((resolve) => setTimeout(resolve, 5))
  }
  async function request(
    f: Record<string, unknown>,
  ): Promise<ConfigurationResponseFrame | undefined> {
    const auth = await w.authorize(browser, b, f)
    session.receive(
      encodeBrowserChannelMessage({
        v: 1,
        t: 'request',
        frame: encodeConfigurationRequest(f),
        ...auth,
      }),
    )
    const message = await next()
    return message?.t === 'response'
      ? decodeConfigurationResponse(message.frame)
      : undefined
  }
  /** Sends the browser's inventory message; returns the Connector's result. */
  async function inventory(
    receipt: SignedConfigurationReceipt,
    attestation?: string,
    over: Record<string, unknown> = {},
  ) {
    session.receive(
      await w.inventoryMessage(
        receipt,
        attestation ?? (await w.ack({ binding: b }, receipt)),
        over,
      ),
    )
    return next()
  }
  return { session, binding: b, request, inventory, next }
}

const receiptOf = (response: ConfigurationResponseFrame | undefined) => {
  if (response?.type !== 'result') throw new Error('no receipt')
  return response.receipt
}
async function commitOnce(
  w: World,
  t: Awaited<ReturnType<typeof connect>>,
  op = randomUUID(),
) {
  const prepared = await t.request(prepareFrame(op))
  if (prepared?.type !== 'result' || prepared.state !== 'prepared')
    throw new Error('prepare failed')
  const committed = await t.request(await commitFrame(op, prepared))
  if (committed?.type !== 'result' || committed.state !== 'local-committed')
    throw new Error('commit failed')
  return { op, prepared, committed, receipt: committed.receipt }
}

describe('inventory confirmation: activation gating', () => {
  it('a new assignment never collects before the authenticated ack; the confirmed collector keeps running across commit, restart and confirmation', async () => {
    const w = await world({ moonraker: true })
    const first = w.boot()
    await first.start()
    expect(w.env.collected).toEqual([['voron']])
    const browser = await browserKey()
    const a = await connect(w, first, browser)
    const { op, receipt } = await commitOnce(w, a)

    // The committed file holds the new assignment; the collector is untouched.
    expect(w.readRuntimeFile().assignments).toHaveLength(2)
    expect(w.env.starts).toBe(1)
    expect(w.env.stops).toBe(0)
    expect(first.diagnostics().runtimeActive).toBe(true)

    // Restart with the pending local commit: Moonraker keeps collecting,
    // the pending Kobra assignment still does not.
    await first.shutdown()
    const second = w.boot()
    expect(await second.start()).toEqual({ pendingInventory: 1 })
    expect(w.env.collected.at(-1)).toEqual(['voron'])
    const snapshot = JSON.parse(readFileSync(w.snapshotPath, 'utf8'))
    expect(snapshot.assignments).toHaveLength(1)
    expect(snapshot.collection.version).toBe(1)
    expect(snapshot.collection.kobralink).toBeUndefined()
    // The committed file itself is never rewritten by gating.
    expect(w.readRuntimeFile().assignments).toHaveLength(2)

    // Fresh session of the same owner: status (fresh authority), then the
    // newly issued signed ack from the server's registration replay.
    const b = await connect(w, second, browser)
    expect(receiptOf(await b.request(await statusFrame(op))).receipt_id).toBe(
      receipt.receipt_id,
    )
    const result = await b.inventory(receipt)
    expect(result).toMatchObject({ t: 'inventory-result', ok: true })
    if (result?.t !== 'inventory-result' || !result.receipt)
      throw new Error('no confirmation')
    expect(decodeConfigurationReceipt(result.receipt).phase).toBe(
      'inventory-confirmed',
    )

    // Canonical identity: exactly the server derivation of the stable tuple.
    const canonical = await deriveConfigurationAssignmentIdentity({
      account_id: 'account_owner',
      farm_id: w.ids.farm,
      agent_id: w.ids.agent,
      bridge_instance_id: receipt.target.bridge_instance_id,
      device_id: receipt.target.device_id,
    })
    const file = w.readRuntimeFile()
    expect(file.assignments[1]).toMatchObject(canonical)
    expect(file.assignments[0].assignment_id).toBe(w.moonrakerId)
    expect(w.env.collected.at(-1)).toEqual(
      ['voron', canonical.printer_key].sort(),
    )
    expect(w.bridge.state.creates).toBe(1)
    expect([...(await second.engine.unconfirmedAssignmentIds())]).toEqual([])
  })

  it('a zero-printer Connector starts nothing until the first ack is durable', async () => {
    const w = await world()
    const runtime = w.boot()
    await runtime.start()
    const t = await connect(w, runtime, await browserKey())
    const { receipt } = await commitOnce(w, t)
    expect(w.env.starts).toBe(0)
    expect(runtime.diagnostics().runtimeActive).toBe(false)
    expect(existsSync(w.snapshotPath)).toBe(false)
    expect(await t.inventory(receipt)).toMatchObject({ ok: true })
    expect(w.env.starts).toBe(1)
    expect(w.env.collected[0]).toHaveLength(1)
    expect(w.env.collected[0]![0]).toMatch(/^kobra-x-[A-Za-z0-9_-]{43}$/)
  })

  it('never takes over a foreign mapping holding the canonical identity and keeps collectors running', async () => {
    const w = await world({ moonraker: true })
    const runtime = w.boot()
    await runtime.start()
    const t = await connect(w, runtime, await browserKey())
    const op = randomUUID()
    const prepared = await t.request(prepareFrame(op))
    if (prepared?.type !== 'result') throw new Error('prepare failed')
    const canonical = await deriveConfigurationAssignmentIdentity({
      account_id: 'account_owner',
      farm_id: w.ids.farm,
      agent_id: w.ids.agent,
      bridge_instance_id: prepared.receipt.target.bridge_instance_id,
      device_id: prepared.receipt.target.device_id,
    })
    const seeded = w.readRuntimeFile()
    seeded.assignments.push({
      ...seeded.assignments[0],
      assignment_id: randomUUID(),
      printer_key: canonical.printer_key,
    })
    writeFileSync(w.runtimeConfigPath, JSON.stringify(seeded), { mode: 0o600 })
    const bytes = readFileSync(w.runtimeConfigPath, 'utf8')
    expect(await t.request(await commitFrame(op, prepared))).toMatchObject({
      type: 'error',
      code: 'identity-conflict',
    })
    expect(readFileSync(w.runtimeConfigPath, 'utf8')).toBe(bytes)
    expect(w.env.stops).toBe(0)
    expect(w.env.starts).toBe(1)
  })
})

describe('inventory confirmation: authority and recovery', () => {
  it('a lost ack after restart is recovered only through fresh authority; the ack alone is no command authority', async () => {
    const w = await world()
    const first = w.boot()
    await first.start()
    const browser = await browserKey()
    const a = await connect(w, first, browser)
    const { op, receipt } = await commitOnce(w, a)
    // The server registered and signed an ack, but it never reached us.
    await first.shutdown()

    const second = w.boot()
    expect(await second.start()).toEqual({ pendingInventory: 1 })
    const b = await connect(w, second, browser)
    // A valid ack for this very session, but no admitted capability: refused.
    expect(await b.inventory(receipt)).toMatchObject({
      ok: false,
      reason: 'rejected',
    })
    expect(w.env.starts).toBe(0)
    expect(await second.engine.pendingInventoryConfirmations()).toHaveLength(1)

    receiptOf(await b.request(await statusFrame(op)))
    // The credential is replaced after admission: the old context is dead.
    const replaced = randomUUID()
    const original = w.env.jti
    w.env.jti = replaced
    expect(await b.inventory(receipt)).toMatchObject({
      ok: false,
      reason: 'rejected',
    })
    expect(w.env.starts).toBe(0)

    // The newly accepted credential recovers through a fresh full session.
    const c = await connect(
      w,
      second,
      browser,
      { credential_jti: replaced },
      { credentialJti: replaced },
    )
    receiptOf(await c.request(await statusFrame(op)))
    expect(await c.inventory(receipt)).toMatchObject({ ok: true })
    expect(w.env.starts).toBe(1)
    expect(w.bridge.state.creates).toBe(1)
    expect(original).not.toBe(replaced)
  })

  it('an expired binding recovers with a new session of the same owner; cross-owner and other key never confirm', async () => {
    const w = await world()
    const runtime = w.boot()
    await runtime.start()
    const browser = await browserKey()
    const a = await connect(w, runtime, browser)
    const { op, receipt } = await commitOnce(w, a)
    w.env.now += 31_000
    a.session.close('binding-expired')

    const otherOwner = await connect(w, runtime, browser, {
      account_id: 'account_admin',
    })
    expect(await otherOwner.request(await statusFrame(op))).toMatchObject({
      type: 'error',
      code: 'capability-rejected',
    })
    expect(await otherOwner.inventory(receipt)).toMatchObject({
      ok: false,
      reason: 'rejected',
    })
    const otherKeyBrowser = await browserKey()
    const otherKey = await connect(w, runtime, otherKeyBrowser, {
      key_id: randomUUID(),
    })
    expect(await otherKey.request(await statusFrame(op))).toMatchObject({
      type: 'error',
      code: 'capability-rejected',
    })
    expect(await otherKey.inventory(receipt)).toMatchObject({
      ok: false,
      reason: 'rejected',
    })
    expect(w.env.starts).toBe(0)

    const b = await connect(w, runtime, browser)
    receiptOf(await b.request(await statusFrame(op)))
    expect(await b.inventory(receipt)).toMatchObject({ ok: true })
    expect(w.env.starts).toBe(1)
  })

  it('refuses expired and forged acks and a server outage; replay is idempotent only under current authority', async () => {
    const w = await world()
    const runtime = w.boot()
    await runtime.start()
    const browser = await browserKey()
    const t = await connect(w, runtime, browser)
    const { op, receipt } = await commitOnce(w, t)

    const stale = await w.ack(t, receipt)
    w.env.now += 26_000
    expect(await t.inventory(receipt, stale)).toMatchObject({
      ok: false,
      reason: 'rejected',
    })
    expect(await t.inventory(receipt, 'x'.repeat(40))).toMatchObject({
      ok: false,
      reason: 'rejected',
    })
    w.env.online = false
    expect(await t.inventory(receipt)).toMatchObject({
      ok: false,
      reason: 'rejected',
    })
    w.env.online = true
    expect(w.env.starts).toBe(0)

    const confirmed = await t.inventory(receipt)
    expect(confirmed).toMatchObject({ ok: true })
    expect(w.env.starts).toBe(1)

    // Identical replay: same receipt, no restart, but only with authority.
    const replay = await t.inventory(receipt)
    expect(replay).toMatchObject({ ok: true })
    expect(replay).toEqual({ ...confirmed, ...{} })
    expect(w.env.starts).toBe(1)
    w.env.online = false
    expect(await t.inventory(receipt)).toMatchObject({ ok: false })
    w.env.online = true
    // A new session has no admission for this operation until it asks.
    const fresh = await connect(w, runtime, browser)
    expect(await fresh.inventory(receipt)).toMatchObject({ ok: false })
    receiptOf(await fresh.request(await statusFrame(op)))
    expect(await fresh.inventory(receipt)).toMatchObject({ ok: true })
    expect(w.env.starts).toBe(1)
  })

  it('uses only the public HTTPS issuer metadata of the pinned origin', async () => {
    const w = await world()
    const runtime = w.boot()
    await runtime.start()
    const t = await connect(w, runtime, await browserKey())
    const { receipt } = await commitOnce(w, t)
    expect(await t.inventory(receipt)).toMatchObject({ ok: true })
    expect(w.env.issuerRequests.length).toBeGreaterThan(0)
    for (const { url, init } of w.env.issuerRequests) {
      expect(url).toBe(FARM_ORIGIN + '/api/configuration-authority/issuer')
      expect(init.method).toBe('GET')
      expect(init.redirect).toBe('error')
      expect(init.credentials).toBe('omit')
      expect(init.headers).toEqual({ accept: 'application/json' })
    }
  })

  it('shutdown stops the collector, closes sessions and refuses later confirmation', async () => {
    const w = await world()
    const runtime = w.boot()
    await runtime.start()
    const t = await connect(w, runtime, await browserKey())
    const { receipt } = await commitOnce(w, t)
    expect(await t.inventory(receipt)).toMatchObject({ ok: true })
    expect(runtime.diagnostics().runtimeActive).toBe(true)
    await runtime.shutdown()
    expect(w.env.stops).toBe(w.env.starts)
    expect(t.session.state).toBe('closed')
    expect(runtime.diagnostics()).toMatchObject({
      sessions: 0,
      openTransports: 0,
      admittedCapabilities: 0,
      runtimeActive: false,
    })
    expect(() =>
      runtime.openSession({ expected: {} as never, send: () => {} }),
    ).toThrow()
  })
})
