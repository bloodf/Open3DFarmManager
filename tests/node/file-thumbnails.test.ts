import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listMoonrakerFiles } from '../../packages/connector/src/moonraker/files.ts'

for (const fixture of [
  { label: 'valid PNG', path: '.thumbs/part.png', size: 8, valid: true },
  { label: 'oversize', path: '.thumbs/part.png', size: 65537, valid: false },
  { label: 'path traversal', path: '../../private.png', size: 8, valid: false },
  { label: 'non-PNG', path: '.thumbs/part.png', size: 8, valid: false },
]) {
  test(`Moonraker thumbnail: ${fixture.label}`, async () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    const files = await listMoonrakerFiles(
      {
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
    const file = files[0]
    assert.ok(file)
    const thumbnail = Reflect.get(file, 'thumbnail')
    if (fixture.valid) assert.equal(thumbnail, png.toString('base64'))
    else assert.equal(thumbnail, undefined)
  })
}
