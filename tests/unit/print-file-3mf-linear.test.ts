import { describe, expect, it } from 'vitest'
import { crc32, deflateRawSync } from 'node:zlib'
import { readThreeMf } from '../../packages/shared/src/print-file/3mf-meta.ts'

function buildZip(files: Record<string, string>): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [path, content] of Object.entries(files)) {
    const data = Buffer.from(content)
    const body = deflateRawSync(data)
    const name = Buffer.from(path)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc32(data), 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(8, 10)
    header.writeUInt32LE(crc32(data), 16)
    header.writeUInt32LE(body.length, 20)
    header.writeUInt32LE(data.length, 24)
    header.writeUInt16LE(name.length, 28)
    header.writeUInt32LE(offset, 42)
    central.push(header, name)
    parts.push(local, name, body)
    offset += 30 + name.length + body.length
  }
  const directory = Buffer.concat(central)
  const count = Object.keys(files).length
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(count, 8)
  eocd.writeUInt16LE(count, 10)
  eocd.writeUInt32LE(directory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, directory, eocd])
}

describe('3MF metadata attribute scanning', () => {
  it('parses an 80k malformed attribute in linear time', async () => {
    const archive = buildZip({
      '3D/3dmodel.model': '<model/>',
      'Metadata/slice_info.config': `<config><header><header_item junk="${'a'.repeat(80_000)}></header_item><header_item key="X-BBL-Client-Type" value="slicer"/></header></config>`,
    })
    const start = performance.now()
    const result = await readThreeMf(archive)
    const elapsed = performance.now() - start

    expect(result).toMatchObject({
      ok: true,
      project: { slicer: 'Bambu Studio' },
    })
    expect(elapsed).toBeLessThan(100)
  })
})
