import { test } from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createThumbnailDownload } from '../../packages/connector/src/moonraker/files.ts'
import assert from 'node:assert/strict'
import { PrinterFile } from '../../packages/farm-protocol/src/file-list.ts'
import { listMoonrakerFiles } from '../../packages/connector/src/moonraker/files.ts'

for (const fixture of [
  { label: 'valid PNG', path: '.thumbs/part.png', size: 8, valid: true },
  { label: 'oversize', path: '.thumbs/part.png', size: 65537, valid: false },
  { label: 'path traversal', path: '../../private.png', size: 8, valid: false },
  { label: 'non-PNG', path: '.thumbs/part.png', size: 8, valid: false },
]) {
  test(`Moonraker thumbnail: ${fixture.label}`, async () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    const downloads: string[] = []
    const files = await listMoonrakerFiles(
      {
        async downloadThumbnail(path: string) {
          downloads.push(path)
          return new Response(
            fixture.label === 'non-PNG' ? Buffer.alloc(8) : png,
          )
        },
        async request(method: string): Promise<unknown> {
          if (method === 'server.files.list')
            return [{ path: 'part.gcode', size: 100, modified: 1 }]
          return {
            thumbnails: [{ relative_path: fixture.path, size: fixture.size }],
          }
        },
      },
      { limit: 200 },
    )
    assert.deepEqual(
      downloads,
      fixture.label === 'oversize' || fixture.label === 'path traversal'
        ? []
        : ['gcodes/.thumbs/part.png'],
    )
    const file = files[0]
    assert.ok(file)
    const thumbnail = Reflect.get(file, 'thumbnail')
    if (fixture.valid) assert.equal(thumbnail, png.toString('base64'))
    else assert.equal(thumbnail, undefined)
  })
}

test('bounds downloaded bytes independently of metadata and picks the largest eligible image', async () => {
  const paths: string[] = []
  const files = await listMoonrakerFiles(
    {
      async request(method) {
        return method === 'server.files.list'
          ? [{ path: 'folder/part.gcode', size: 100, modified: 1 }]
          : {
              estimated_time: 42,
              thumbnails: [
                { relative_path: '.thumbs/small.png', size: 8 },
                { relative_path: '.thumbs/large.png', size: 64000 },
                { relative_path: '.thumbs/too-large.png', size: 65537 },
              ],
            }
      },
      async downloadThumbnail(path) {
        paths.push(path)
        return new Response(Buffer.alloc(65537))
      },
    },
    { limit: 200 },
  )
  assert.deepEqual(paths, ['gcodes/folder/.thumbs/large.png'])
  assert.deepEqual(files, [
    { name: 'folder/part.gcode', size: 100, modified: 1, estimatedTime: 42 },
  ])
})

test('limits thumbnail downloads to 50 per list and preserves PNG payloads in the DTO', async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  )
  let downloads = 0
  const files = await listMoonrakerFiles(
    {
      async request(method) {
        return method === 'server.files.list'
          ? Array.from({ length: 60 }, (_, i) => ({
              path: `${i}.gcode`,
              size: 1,
              modified: i,
            }))
          : {
              thumbnails: [
                { relative_path: '.thumbs/part.png', size: png.length },
              ],
            }
      },
      async downloadThumbnail() {
        downloads++
        return new Response(png)
      },
    },
    { limit: 200 },
  )
  assert.equal(downloads, 50)
  assert.equal(files.filter((file) => file.thumbnail).length, 50)
  assert.equal(PrinterFile.parse(files[0]).thumbnail, png.toString('base64'))
  assert.equal(
    PrinterFile.safeParse({
      ...files[0],
      thumbnail: Buffer.alloc(65537).toString('base64'),
    }).success,
    false,
  )
})

test('Connector downloads thumbnails from the configured loopback origin', async () => {
  const paths: string[] = []
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const server = createServer((request, response) => {
    paths.push(request.url ?? '')
    response.end(png)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const downloadThumbnail = createThumbnailDownload({
      origin: `http://127.0.0.1:${address.port}`,
      signal: new AbortController().signal,
      limits: {
        maxMessageBytes: 262144,
        connectTimeoutMs: 1000,
        requestTimeoutMs: 1000,
        staleAfterMs: 1000,
        reconnectMinMs: 100,
        reconnectMaxMs: 1000,
      },
    })
    const files = await listMoonrakerFiles(
      {
        downloadThumbnail,
        async request(method) {
          return method === 'server.files.list'
            ? [{ path: 'part.gcode', size: 1, modified: 1 }]
            : { thumbnails: [{ relative_path: '.thumbs/part.png', size: 8 }] }
        },
      },
      { limit: 200 },
    )
    assert.deepEqual(paths, ['/server/files/gcodes/.thumbs/part.png'])
    assert.equal(files[0]?.thumbnail, png.toString('base64'))
    await assert.rejects(downloadThumbnail('gcodes/../secret'))
    assert.equal(paths.length, 1)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})
