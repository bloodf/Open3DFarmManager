import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { createKobraLinkClient } from '../../packages/connector/src/kobralink/client.ts'
import { createFilesFixture } from '../fixtures/kobralink-integration/files.ts'

async function ready() {
  const fixture = createFilesFixture()
  const origin = 'http://127.0.0.1:7100'
  const client = createKobraLinkClient({
    origin,
    allowedOrigins: [origin],
    fetch: fixture.fetch,
  })
  await client.authenticate({
    ownership: 'fresh_owned',
    mode: 'signin',
    name: 'Connector',
    email: 'c@example.test',
    password: 'synthetic-password',
  })
  fixture.state.printState = 'standby'
  return { ...fixture, client }
}
const binding = { id: 'printer-1', deviceId: 'synthetic-device' }
describe('KobraLink files', () => {
  it('lists printer files and starts a printer-local file', async () => {
    const f = await ready()
    expect(await f.client.listPrinterFiles(binding)).toEqual([
      { filename: 'part.gcode', sizeBytes: 4, timestamp: 123 },
    ])
    expect(
      await f.client.controlExtendedPrinter(binding.id, {
        action: 'start_print',
        args: { file: 'part.gcode' },
      }),
    ).toEqual({ accepted: true, confirmed: false })
    expect(f.extended).toEqual([
      {
        path: '/api/v1/printers/printer-1/printer-files/print',
        body: { filename: 'part.gcode', sizeBytes: 0 },
      },
    ])
  })
  it('uploads a staged file to the bridge library without starting it', async () => {
    const f = await ready()
    const dir = await mkdtemp(join(tmpdir(), 'kobralink-files-'))
    try {
      const path = join(dir, 'staged')
      await writeFile(path, 'G28\n')
      expect(await f.client.uploadFile(binding, path, 'part.gcode')).toEqual({
        id: 'file-1',
      })
      expect(await f.client.listLibraryFiles(binding)).toEqual([
        { id: 'file-1', filename: 'part.gcode', sizeBytes: 4 },
      ])
      expect(await f.client.startLibraryFile(binding, 'file-1')).toEqual({
        accepted: true,
        confirmed: false,
      })
      expect(f.starts).toEqual([{ fileId: 'file-1', excludedObjects: [] }])
      expect(f.uploads).toEqual([
        { name: 'part.gcode', content: 'G28\n', print: 'false' },
      ])
      await expect(
        f.client.uploadFile(binding, path, '../part.gcode'),
      ).rejects.toThrow()
      expect(f.uploads).toHaveLength(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('rejects malformed listings and changed identity', async () => {
    const f = await ready()
    f.setListing([{ filename: '../evil', sizeBytes: 1, timestamp: 1 }])
    await expect(f.client.listPrinterFiles(binding)).rejects.toMatchObject({
      code: 'invalid',
    })
    f.state.deviceId = 'other'
    await expect(f.client.listPrinterFiles(binding)).rejects.toMatchObject({
      code: 'identity_changed',
    })
  })
})
