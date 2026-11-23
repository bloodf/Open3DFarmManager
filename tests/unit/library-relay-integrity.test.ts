import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { expect, test } from 'vitest'
import { ConnectorLibraryRelayHub } from '../../apps/farm/server/utils/library/connector-relay.ts'

const identity = { farmId: 'farm', agentId: 'connector' }
const chunks = [Buffer.from('streamed '), Buffer.from('content\n')]
const bytes = Buffer.concat(chunks)
const sha256 = createHash('sha256').update(bytes).digest('hex')
const headers = new Headers()

test.each([
  {
    label: 'matching report',
    hash: sha256,
    size: bytes.length,
    accepted: true,
  },
  {
    label: 'wrong hash',
    hash: 'a'.repeat(64),
    size: bytes.length,
    accepted: false,
  },
  { label: 'wrong size', hash: sha256, size: 1, accepted: false },
])('$label on a relayed upload', async ({ hash, size, accepted }) => {
  const hub = new ConnectorLibraryRelayHub({
    authenticate: async () => identity,
  })
  const recorded: string[] = []
  try {
    const upload = hub
      .put({ ...identity, body: Readable.from(chunks), maxBytes: bytes.length })
      .then((stored) => {
        recorded.push(stored.sha256)
        return stored
      })
    const outcome = accepted
      ? expect(upload).resolves.toEqual({ sha256, size, created: true })
      : expect(upload).rejects.toThrow('dados de integridade divergentes')

    const claimed = await hub.poll(headers)
    expect(claimed?.op?.type).toBe('put')
    const opId = claimed!.op!.op_id
    const body = await hub.body(headers, opId)
    if (body.status !== 200) throw new Error('Expected an upload stream')
    expect(
      await new Response(Readable.toWeb(body.stream) as ReadableStream).text(),
    ).toBe(bytes.toString())

    const report = (id: string, result: unknown) =>
      hub.result(
        headers,
        id,
        'application/json',
        new Response(JSON.stringify(result)).body,
      )
    expect(
      await report(opId, {
        ok: true,
        type: 'put',
        sha256: hash,
        size,
        created: true,
      }),
    ).toEqual({ status: 204 })

    if (!accepted) {
      const discard = (await hub.poll(headers))?.op
      expect(discard).toMatchObject({ type: 'discard', sha256: hash })
      await report(discard!.op_id, { ok: true, type: 'discard' })
    }

    await outcome
    expect(recorded).toEqual(accepted ? [sha256] : [])
  } finally {
    hub.close()
  }
})
