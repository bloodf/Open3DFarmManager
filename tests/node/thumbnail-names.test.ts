import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import {
  createThumbnailDownload,
  listMoonrakerFiles,
} from '../../packages/connector/src/moonraker/files.ts'

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const invalid = [
  '../secret',
  'folder/../secret',
  './secret',
  '/secret',
  'folder//secret',
  'a%2Fb',
  'a%2fb',
  'a%5Cb',
  'a\\b',
  ...Array.from({ length: 32 }, (_, i) => `a${String.fromCharCode(i)}b`),
  ...Array.from({ length: 33 }, (_, i) => `a${String.fromCharCode(127 + i)}b`),
]

for (const name of ['my benchy', 'pasta ação/模型 bonito']) {
  test(`downloads and encodes thumbnail segments: ${name}`, async () => {
    const urls: string[] = []
    const server = createServer((req, res) => {
      urls.push(req.url ?? '')
      res.end(png)
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
              ? [{ path: `${name}.gcode`, size: 1, modified: 1 }]
              : {
                  thumbnails: [
                    { relative_path: '.thumbs/ação 模型.png', size: 8 },
                  ],
                }
          },
        },
        { limit: 1 },
      )
      assert.equal(files[0]?.thumbnail, png.toString('base64'))
      const directory = name.includes('/')
        ? name.slice(0, name.lastIndexOf('/') + 1)
        : ''
      assert.deepEqual(urls, [
        `/server/files/gcodes/${`${directory}.thumbs/ação 模型.png`.split('/').map(encodeURIComponent).join('/')}`,
      ])
      for (const path of invalid) {
        await assert.rejects(
          downloadThumbnail(`gcodes/${path}`),
          /Invalid thumbnail path/,
        )
      }
      assert.equal(urls.length, 1)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  })
}

for (const path of invalid) {
  for (const target of ['file', 'thumbnail']) {
    test(`rejects unsafe ${target} path ${JSON.stringify(path)}`, async () => {
      let downloads = 0
      const files = await listMoonrakerFiles(
        {
          async request(method) {
            return method === 'server.files.list'
              ? [
                  {
                    path: target === 'file' ? path : 'my benchy.gcode',
                    size: 1,
                    modified: 1,
                  },
                ]
              : {
                  thumbnails: [
                    {
                      relative_path:
                        target === 'thumbnail' ? path : '.thumbs/my benchy.png',
                      size: 8,
                    },
                  ],
                }
          },
          async downloadThumbnail() {
            downloads++
            return new Response(png)
          },
        },
        { limit: 1 },
      )
      assert.equal(downloads, 0)
      assert.equal(files[0]?.thumbnail, undefined)
    })
  }
}
