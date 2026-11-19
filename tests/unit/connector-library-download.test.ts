import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { expect, test } from 'vitest'
import {
  activateConnectorLibraryDownload,
  connectorLibraryDownload,
  createConnectorLibraryDownload,
  deactivateConnectorLibraryDownload,
  type ConnectorLibraryDownloadResponse,
  type DownloadAuditEntry,
  type LibraryBlobRecord,
} from '../../apps/farm/server/utils/library/connector-download.ts'

const farm = randomUUID()
const otherFarm = randomUUID()
const agent = randomUUID()
const content = Buffer.from('G1 X10 Y10\nG1 X20 Y20\n')
const sha = createHash('sha256').update(content).digest('hex')
const connectorSha = createHash('sha256').update('kept').digest('hex')

function setup(options: { perMinute?: number; failAudit?: boolean } = {}) {
  const revoked = new Set<string>()
  const audits: DownloadAuditEntry[] = []
  const reads: string[] = []
  // Blobs per farm: only `farm` owns them.
  const blobs = new Map<string, LibraryBlobRecord>([
    [
      `${farm}/${sha}`,
      { storageLocation: 'server', sizeBytes: content.length },
    ],
    [`${farm}/${connectorSha}`, { storageLocation: 'connector', sizeBytes: 4 }],
  ])
  const download = createConnectorLibraryDownload({
    authenticate: async (headers) => {
      const id = headers.get('x-connector-agent')
      const owner = headers.get('x-connector-farm')
      if (!id || !owner || headers.get('authorization') !== 'Bearer ok')
        return null
      return revoked.has(id) ? null : { agentId: id, farmId: owner }
    },
    findBlob: async (farmId, hash) => blobs.get(`${farmId}/${hash}`) ?? null,
    blobs: {
      read: async (hash, range) => {
        reads.push(hash)
        const part = range
          ? content.subarray(range.start, range.end + 1)
          : content
        return { size: content.length, range, stream: Readable.from([part]) }
      },
    },
    audit: async (entry) => {
      if (options.failAudit) throw new Error('db down')
      audits.push(entry)
    },
    ...(options.perMinute === undefined
      ? {}
      : { perMinute: options.perMinute }),
  })
  const headers = (extra: Record<string, string> = {}, farmId = farm) =>
    new Headers({
      authorization: 'Bearer ok',
      'x-connector-agent': agent,
      'x-connector-farm': farmId,
      ...extra,
    })
  return { download, headers, revoked, audits, reads }
}

async function bytes(response: ConnectorLibraryDownloadResponse) {
  const parts: Buffer[] = []
  for await (const part of response.body as Readable)
    parts.push(Buffer.from(part))
  return Buffer.concat(parts)
}

test('serves whole file with Content-Length and one audit row', async () => {
  const { download, headers, audits } = setup()
  const res = await download(sha, headers())
  expect(res.status).toBe(200)
  expect(res.headers['content-length']).toBe(String(content.length))
  expect(res.headers['accept-ranges']).toBe('bytes')
  expect(await bytes(res)).toEqual(content)
  expect(audits).toHaveLength(1)
  expect(audits[0]).toMatchObject({
    farmId: farm,
    agentId: agent,
    sha256: sha,
    outcome: 'served',
    range: null,
    bytes: content.length,
  })
})

test('resume with a range request returns 206 and only the tail', async () => {
  const { download, headers, audits } = setup()
  const res = await download(sha, headers({ range: 'bytes=11-' }))
  expect(res.status).toBe(206)
  expect(res.headers['content-range']).toBe(
    `bytes 11-${content.length - 1}/${content.length}`,
  )
  expect(res.headers['content-length']).toBe(String(content.length - 11))
  expect(await bytes(res)).toEqual(content.subarray(11))
  expect(audits[0]).toMatchObject({
    outcome: 'served',
    range: { start: 11, end: content.length - 1 },
    bytes: content.length - 11,
  })
})

test('unsatisfiable range answers 416 and sends no bytes', async () => {
  const { download, headers, audits, reads } = setup()
  const res = await download(
    sha,
    headers({ range: `bytes=${content.length}-` }),
  )
  expect(res.status).toBe(416)
  expect(res.headers['content-range']).toBe(`bytes */${content.length}`)
  expect(reads).toEqual([])
  expect(audits[0]?.outcome).toBe('bad-range')
})

test('foreign-farm requests are refused as not found, with no bytes', async () => {
  const { download, headers, audits, reads } = setup()
  // Connector of another farm asks for this farm's blob.
  const res = await download(sha, headers({}, otherFarm))
  expect(res.status).toBe(404)
  expect(res.body).not.toBeInstanceOf(Readable)
  expect(reads).toEqual([])
  expect(audits[0]).toMatchObject({ farmId: otherFarm, outcome: 'not-found' })
})

test('revoked or unauthenticated Connector is refused before any lookup', async () => {
  const { download, headers, revoked, audits, reads } = setup()
  revoked.add(agent)
  expect((await download(sha, headers())).status).toBe(403)
  revoked.clear()
  const anonymous = new Headers({ 'x-connector-agent': agent })
  expect((await download(sha, anonymous)).status).toBe(403)
  expect(reads).toEqual([])
  expect(audits).toEqual([])
})

test('a file kept on the Connector is refused with a clear message and no bytes', async () => {
  const { download, headers, audits, reads } = setup()
  const res = await download(connectorSha, headers())
  expect(res.status).toBe(409)
  expect(res.body).toEqual({
    error: 'O arquivo está guardado no Connector, não no servidor.',
  })
  expect(reads).toEqual([])
  expect(audits[0]?.outcome).toBe('kept-on-connector')
})

test('rate limit answers 429 with retry-after and audits the refusal', async () => {
  const { download, headers, audits } = setup({ perMinute: 2 })
  expect((await download(sha, headers())).status).toBe(200)
  expect((await download(sha, headers())).status).toBe(200)
  const res = await download(sha, headers())
  expect(res.status).toBe(429)
  expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1)
  expect(audits.map((a) => a.outcome)).toEqual([
    'served',
    'served',
    'rate-limited',
  ])
})

test('no bytes are sent when the audit row cannot be written', async () => {
  const { download, headers, reads } = setup({ failAudit: true })
  const res = await download(sha, headers())
  expect(res.status).toBe(503)
  expect(res.body).not.toBeInstanceOf(Readable)
  expect(reads).toHaveLength(1) // stream opened then destroyed
})

test('rejects malformed hashes; handler is inactive until activated', async () => {
  const { download, headers } = setup()
  expect((await download('../etc/passwd', headers())).status).toBe(400)
  expect((await download(sha.toUpperCase(), headers())).status).toBe(400)
  expect(connectorLibraryDownload()).toBeUndefined()
  activateConnectorLibraryDownload(download)
  expect(connectorLibraryDownload()).toBe(download)
  expect(() => activateConnectorLibraryDownload(download)).toThrow()
  deactivateConnectorLibraryDownload()
  expect(connectorLibraryDownload()).toBeUndefined()
})
