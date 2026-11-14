import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { configurationOpaqueId } from '../../../farm-protocol/src/configuration-common.ts'
import { KobraLinkError } from '../kobralink/client.ts'
import { readPrivateJson, writePrivateJsonAtomic } from './private-fs.ts'

/**
 * Connector-local custody of the independent bridge machine account. The
 * account is unrelated to any OpenFarm login, session or server secret and
 * never leaves this file: no DTO, receipt, journal entry or error carries it.
 */
const Account = z.strictObject({
  name: z.string().min(1).max(128),
  email: z.email().max(254),
  password: z.string().min(32).max(256),
})
export type BridgeAccount = z.infer<typeof Account>
const Bridge = z.strictObject({
  bridge_instance_id: configurationOpaqueId,
  origin: z.string().min(1).max(2048),
  ownership: z.literal('connector-owned'),
  /**
   * signup-pending: credentials persisted before the first signup; outcome of
   * that signup may be unknown. conflict: the service was initialized by
   * someone else; it is never reset or taken over.
   */
  state: z.enum(['signup-pending', 'established', 'conflict']),
  account: Account,
})
export type BridgeRecord = z.infer<typeof Bridge>
const Custody = z.strictObject({
  v: z.literal(1),
  bridges: z.array(Bridge).max(4),
})
type Custody = z.infer<typeof Custody>

export type BridgeOutcome =
  | { ok: true; bridge: BridgeRecord }
  | { ok: false; reason: 'foreign-initialized' | 'unavailable' | 'unknown' }

/** Narrow subset of the accepted KobraLink client used for bootstrap. */
export interface BridgeAuthClient {
  setupStatus(): Promise<{ needsSetup: boolean }>
  authenticate(input: {
    ownership: 'fresh_owned'
    mode: 'signup' | 'signin'
    name: string
    email: string
    password: string
  }): Promise<unknown>
}

export function createBridgeCustody(directory: string) {
  const path = join(directory, 'bridge-custody.json')
  const read = (): Custody => {
    const raw = readPrivateJson(path)
    return raw === null ? { v: 1, bridges: [] } : Custody.parse(raw)
  }
  const save = (custody: Custody) =>
    writePrivateJsonAtomic(path, Custody.parse(custody))
  const replace = (record: BridgeRecord) => {
    const custody = read()
    save({
      v: 1,
      bridges: custody.bridges.map((bridge) =>
        bridge.bridge_instance_id === record.bridge_instance_id
          ? record
          : bridge,
      ),
    })
  }

  async function signin(
    client: BridgeAuthClient,
    bridge: BridgeRecord,
  ): Promise<'ok' | 'unauthorized' | 'unavailable'> {
    try {
      await client.authenticate({
        ownership: 'fresh_owned',
        mode: 'signin',
        ...bridge.account,
      })
      return 'ok'
    } catch (error) {
      return error instanceof KobraLinkError && error.code === 'unauthorized'
        ? 'unauthorized'
        : 'unavailable'
    }
  }

  return Object.freeze({
    find(id: string): BridgeRecord | null {
      return read().bridges.find((b) => b.bridge_instance_id === id) ?? null
    },
    findByOrigin(origin: string): BridgeRecord | null {
      return read().bridges.find((b) => b.origin === origin) ?? null
    },
    /**
     * Authenticates an existing established bridge. Never re-provisions,
     * refreshes or rotates credentials when the bridge rejects them.
     */
    async authenticateEstablished(
      client: BridgeAuthClient,
      bridge: BridgeRecord,
    ): Promise<BridgeOutcome> {
      if (bridge.state !== 'established')
        return { ok: false, reason: 'unavailable' }
      const result = await signin(client, bridge)
      return result === 'ok'
        ? { ok: true, bridge }
        : { ok: false, reason: 'unavailable' }
    },
    /**
     * Headless bootstrap of the explicitly owned managed bridge. The caller
     * must hold the exclusive provisioning lock. One authentication attempt per
     * call: the upstream rate limit is a single global bucket.
     */
    async bootstrapManaged(
      client: BridgeAuthClient,
      origin: string,
    ): Promise<BridgeOutcome> {
      let bridge = read().bridges.find((b) => b.origin === origin) ?? null
      if (bridge?.state === 'conflict')
        return { ok: false, reason: 'foreign-initialized' }
      if (bridge?.state === 'established')
        return this.authenticateEstablished(client, bridge)
      let needsSetup: boolean
      try {
        needsSetup = (await client.setupStatus()).needsSetup
      } catch {
        return { ok: false, reason: 'unavailable' }
      }
      if (!bridge) {
        // Initialized and not in our custody: someone else owns it.
        if (!needsSetup) return { ok: false, reason: 'foreign-initialized' }
        const custody = read()
        if (custody.bridges.length >= 4)
          return { ok: false, reason: 'unavailable' }
        const created: BridgeRecord = {
          bridge_instance_id: `bridge-${randomBytes(12).toString('hex')}`,
          origin,
          ownership: 'connector-owned',
          state: 'signup-pending',
          account: {
            name: 'OpenFarm Connector',
            email: `connector-${randomBytes(8).toString('hex')}@connector.invalid`,
            password: randomBytes(32).toString('base64url'),
          },
        }
        // Durable before the first signup so a lost response is recoverable.
        save({ v: 1, bridges: [...custody.bridges, created] })
        bridge = created
      }
      if (!needsSetup) {
        // A previous signup may have landed. Prove it with our own account.
        const result = await signin(client, bridge)
        if (result === 'unavailable') return { ok: false, reason: 'unknown' }
        if (result === 'unauthorized') {
          replace({ ...bridge, state: 'conflict' })
          return { ok: false, reason: 'foreign-initialized' }
        }
      } else {
        try {
          await client.authenticate({
            ownership: 'fresh_owned',
            mode: 'signup',
            ...bridge.account,
          })
        } catch {
          // Outcome unknown: keep signup-pending, reconcile on the next call.
          return { ok: false, reason: 'unknown' }
        }
      }
      const established: BridgeRecord = { ...bridge, state: 'established' }
      replace(established)
      return { ok: true, bridge: established }
    },
  })
}
export type BridgeCustody = ReturnType<typeof createBridgeCustody>
