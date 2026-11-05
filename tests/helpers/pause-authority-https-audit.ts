import { randomUUID } from 'node:crypto'
import type { Sql } from 'postgres'
import { z } from '../../packages/farm-protocol/node_modules/zod/index.js'

const uuid = z.uuid()
const digest = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
export const PauseHttpsAuditRequest = z.strictObject({
  stage: z.enum([
    'initial',
    'negatives',
    'pending',
    'issued',
    'replay',
    'revoked',
  ]),
  transportId: uuid.optional(),
  challengeId: uuid.optional(),
  capabilityHash: digest.optional(),
})
export type PauseHttpsAuditRequest = z.infer<typeof PauseHttpsAuditRequest>
export const PauseHttpsAuditReceipt = z.strictObject({
  rows: z.number().int().min(0).max(4096),
  issued: z.number().int().min(0).max(4096),
  attempts: z.number().int().min(0).max(4096),
  row: z
    .strictObject({
      status: z.enum(['pending', 'issued', 'rejected', 'expired']),
      capabilityId: uuid.nullable(),
      capabilityHash: digest.nullable(),
      scopeMatches: z.boolean(),
      revokedSession: z.boolean(),
      expectedHashMatches: z.boolean(),
    })
    .nullable(),
})
export type PauseHttpsAuditReceipt = z.infer<typeof PauseHttpsAuditReceipt>
const Request = z.strictObject({
  kind: z.literal('pause-audit'),
  id: uuid,
  request: PauseHttpsAuditRequest,
})
const Response = z.strictObject({
  kind: z.literal('pause-audit-result'),
  id: uuid,
  receipt: PauseHttpsAuditReceipt,
})
function bounded(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > 4096)
    throw new Error('Pause audit message exceeded bound')
}
export interface PauseAuditPort {
  connected(): boolean
  send(value: unknown, callback: (error?: Error | null) => void): void
  onMessage(listener: (value: unknown) => void): () => void
  onDisconnect(listener: () => void): () => void
}
/** Fixture IPC only: no SQL text or caller-selected scope crosses this port. */
export function createPauseAuditClient(port: PauseAuditPort) {
  let closed = false,
    count = 0
  let pending:
    | {
        id: string
        finish(error?: Error, receipt?: PauseHttpsAuditReceipt): void
      }
    | undefined
  const close = () => {
    closed = true
    pending?.finish(new Error('Pause audit disconnected'))
    removeMessage()
    removeDisconnect()
  }
  const removeMessage = port.onMessage((value) => {
    try {
      bounded(value)
      const response = Response.parse(value)
      if (!pending || response.id !== pending.id)
        throw new Error('Unexpected pause audit reply')
      pending.finish(undefined, response.receipt)
    } catch {
      close()
    }
  })
  const removeDisconnect = port.onDisconnect(close)
  return {
    close,
    request(input: PauseHttpsAuditRequest): Promise<PauseHttpsAuditReceipt> {
      const request = PauseHttpsAuditRequest.parse(input)
      if (closed || pending || !port.connected() || count >= 24)
        return Promise.reject(new Error('Pause audit unavailable'))
      count++
      const id = randomUUID()
      return new Promise((resolve, reject) => {
        const timer = setTimeout(close, 3000)
        pending = {
          id,
          finish(error, receipt) {
            clearTimeout(timer)
            pending = undefined
            if (error) reject(error)
            else if (receipt) resolve(receipt)
            else reject(new Error('Missing pause audit receipt'))
          },
        }
        try {
          port.send({ kind: 'pause-audit', id, request }, (error) => {
            if (error) close()
          })
        } catch {
          close()
        }
      })
    },
  }
}
export function servePauseAudit(
  port: PauseAuditPort,
  audit: (request: PauseHttpsAuditRequest) => Promise<PauseHttpsAuditReceipt>,
) {
  let closed = false,
    busy = false
  let active: Promise<void> = Promise.resolve()
  const seen = new Set<string>()
  const removeMessage = port.onMessage((value) => {
    if (closed) return
    try {
      bounded(value)
      const request = Request.parse(value)
      if (busy || seen.has(request.id) || seen.size >= 24)
        throw new Error('Pause audit request overflow')
      seen.add(request.id)
      busy = true
      active = audit(request.request)
        .then((input) => {
          const receipt = PauseHttpsAuditReceipt.parse(input)
          const response = {
            kind: 'pause-audit-result',
            id: request.id,
            receipt,
          }
          bounded(response)
          busy = false
          if (!closed && port.connected())
            port.send(response, (error) => {
              if (error) closed = true
            })
        })
        .catch(() => {
          closed = true
          busy = false
        })
    } catch {
      closed = true
    }
  })
  const removeDisconnect = port.onDisconnect(() => {
    closed = true
  })
  return async () => {
    closed = true
    removeMessage()
    removeDisconnect()
    await active
  }
}
export function createPauseDatabaseAudit(
  sql: Sql,
  input: Readonly<{ farmId: string; accountId: string }>,
) {
  const scope = z
    .strictObject({
      farmId: uuid,
      accountId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    })
    .parse(input)
  return async (
    value: PauseHttpsAuditRequest,
  ): Promise<PauseHttpsAuditReceipt> => {
    const request = PauseHttpsAuditRequest.parse(value)
    const totals = (
      await sql`SELECT count(*)::int AS rows,count(*) FILTER (WHERE status='issued')::int AS issued FROM farm.pause_authority_challenges WHERE farm_id=${scope.farmId}::uuid AND account_id=${scope.accountId}`
    )[0]!
    const budget = (
      await sql`SELECT coalesce(sum(p.attempts),0)::int AS attempts FROM farm.pause_authority_sessions p JOIN farm.account_sessions s ON s.id=p.session_id WHERE s.account_id=${scope.accountId}`
    )[0]!
    let row: PauseHttpsAuditReceipt['row'] = null
    if (request.challengeId && request.transportId) {
      const selected =
        await sql`SELECT c.status,c.capability_id,c.capability_hash,s.revoked_at IS NOT NULL AS revoked,
        (c.farm_id=a.farm_id AND c.agent_id=a.agent_id AND c.assignment_id=a.id AND k.account_id=c.account_id AND k.farm_id=c.farm_id AND e.agent_id=c.agent_id AND e.farm_id=c.farm_id AND cr.agent_id=c.agent_id) AS scope_matches
        FROM farm.pause_authority_challenges c JOIN farm.account_sessions s ON s.id=c.session_id
        JOIN farm.printer_assignments a ON a.id=c.assignment_id JOIN farm.browser_device_keys k ON k.key_id=c.key_id
        JOIN farm.connector_enrollments e ON e.agent_id=c.agent_id JOIN farm.connector_credentials cr ON cr.jti=c.credential_jti
        WHERE c.farm_id=${scope.farmId}::uuid AND c.account_id=${scope.accountId} AND c.challenge_id=${request.challengeId}::uuid AND c.transport_id=${request.transportId}::uuid`
      if (selected.length !== 1)
        throw new Error('Pause audit exact row missing')
      const item = selected[0]!
      row = {
        status: item.status,
        capabilityId: item.capability_id,
        capabilityHash: item.capability_hash,
        scopeMatches: item.scope_matches,
        revokedSession: item.revoked,
        expectedHashMatches:
          request.capabilityHash !== undefined &&
          item.capability_hash === request.capabilityHash,
      }
    } else if (
      request.challengeId ||
      request.transportId ||
      request.capabilityHash
    )
      throw new Error('Incomplete pause audit selector')
    return PauseHttpsAuditReceipt.parse({
      rows: totals.rows,
      issued: totals.issued,
      attempts: budget.attempts,
      row,
    })
  }
}
