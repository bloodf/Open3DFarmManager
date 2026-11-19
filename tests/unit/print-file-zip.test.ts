import { describe, expect, it } from 'vitest'
import { crc32, deflateRawSync } from 'node:zlib'
import {
  bufferSource,
  ZipArchive,
  ZipError,
  type ZipErrorCode,
} from '../../packages/shared/src/print-file/zip.ts'

interface Spec {
  name: string
  data?: Buffer
  method?: 0 | 8
  /** Overrides the size written in the headers, to model lying archives. */
  declaredSize?: number
  flags?: number
  localName?: string
}

function buildZip(specs: Spec[], tamper?: (eocd: Buffer) => void): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const spec of specs) {
    const data = spec.data ?? Buffer.alloc(0)
    const method = spec.method ?? 8
    const body = method === 8 ? deflateRawSync(data) : data
    const name = Buffer.from(spec.name)
    const localName = Buffer.from(spec.localName ?? spec.name)
    const size = spec.declaredSize ?? data.length
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(spec.flags ?? 0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc32(data), 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(localName.length, 26)
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(spec.flags ?? 0, 8)
    header.writeUInt16LE(method, 10)
    header.writeUInt32LE(crc32(data), 16)
    header.writeUInt32LE(body.length, 20)
    header.writeUInt32LE(size, 24)
    header.writeUInt16LE(name.length, 28)
    header.writeUInt32LE(offset, 42)
    central.push(header, name)
    parts.push(local, localName, body)
    offset += 30 + localName.length + body.length
  }
  const directory = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(specs.length, 8)
  eocd.writeUInt16LE(specs.length, 10)
  eocd.writeUInt32LE(directory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  tamper?.(eocd)
  return Buffer.concat([...parts, directory, eocd])
}

async function refusal(promise: Promise<unknown>): Promise<ZipError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(ZipError)
  expect((error as ZipError).message.length).toBeGreaterThan(10)
  return error as ZipError
}

const open = (specs: Spec[], limits = {}) =>
  ZipArchive.open(bufferSource(buildZip(specs)), limits)

describe('bounded ZIP reader', () => {
  it('reads stored and deflated entries and finds names case-insensitively', async () => {
    const zip = await open([
      { name: 'a.txt', data: Buffer.from('hello hello hello') },
      { name: 'dir/', data: Buffer.alloc(0), method: 0 },
      { name: 'dir/b.bin', data: Buffer.from([1, 2, 3]), method: 0 },
      { name: 'empty.txt' },
    ])
    expect(Buffer.from(await zip.read('a.txt')).toString()).toBe(
      'hello hello hello',
    )
    expect([...(await zip.read('DIR/b.bin'))]).toEqual([1, 2, 3])
    expect((await zip.read('empty.txt')).length).toBe(0)
    expect(zip.has('missing')).toBe(false)
    expect((await refusal(zip.read('missing'))).code).toBe('entry-not-found')
    expect((await refusal(zip.read('dir/'))).code).toBe('entry-not-found')
  })

  it('scan keeps only the head and tail of a large entry', async () => {
    const filler = Array.from(
      { length: 200_000 },
      (_, i) => `G1 X${(i * 7) % 251}.${i % 97} Y${(i * 13) % 241}.${i % 89}\n`,
    ).join('')
    const body = Buffer.concat([
      Buffer.from('HEAD'),
      Buffer.from(filler),
      Buffer.from('TAIL'),
    ])
    expect(body.length).toBeGreaterThan(3 * 1024 * 1024)
    const zip = await open([{ name: 'big.gcode', data: body }])
    const scan = await zip.scan('big.gcode', 16, 8)
    expect(scan.size).toBe(body.length)
    expect(Buffer.from(scan.head).toString()).toBe(
      body.subarray(0, 16).toString(),
    )
    expect(Buffer.from(scan.tail).toString()).toBe(body.subarray(-8).toString())
    expect(scan.tail.length).toBe(8)
    const stored = await (
      await open([{ name: 's', data: Buffer.from('0123456789'), method: 0 }])
    ).scan('s', 4, 4)
    expect([
      Buffer.from(stored.head).toString(),
      Buffer.from(stored.tail).toString(),
    ]).toEqual(['0123', '6789'])
  })

  const refused: Array<[string, ZipErrorCode, () => Promise<unknown>]> = [
    [
      'garbage bytes',
      'not-zip',
      () =>
        ZipArchive.open(
          bufferSource(Buffer.from('not a zip file at all, really')),
        ),
    ],
    [
      'too many entries',
      'too-many-entries',
      () =>
        open([{ name: 'a' }, { name: 'b' }, { name: 'c' }], { maxEntries: 2 }),
    ],
    [
      'long names',
      'name-too-long',
      () => open([{ name: 'x'.repeat(20) }], { maxNameLength: 10 }),
    ],
    [
      'duplicate entries',
      'duplicate-entry',
      () => open([{ name: 'Metadata/a.txt' }, { name: 'Metadata/a.txt' }]),
    ],
    [
      'case-variant duplicates',
      'duplicate-entry',
      () => open([{ name: 'Metadata/a.txt' }, { name: 'metadata/A.TXT' }]),
    ],
    [
      'dot-dot traversal',
      'path-traversal',
      () => open([{ name: '../evil.txt' }]),
    ],
    [
      'nested traversal',
      'path-traversal',
      () => open([{ name: 'a/../../evil.txt' }]),
    ],
    ['absolute path', 'path-traversal', () => open([{ name: '/etc/passwd' }])],
    ['drive letter', 'path-traversal', () => open([{ name: 'C:/windows/x' }])],
    [
      'backslash separators',
      'invalid-name',
      () => open([{ name: 'a\\..\\b' }]),
    ],
    ['NUL in name', 'invalid-name', () => open([{ name: 'a\0b' }])],
    ['encrypted entries', 'encrypted', () => open([{ name: 'a', flags: 1 }])],
    [
      'entries over the total cap',
      'total-too-large',
      () =>
        open(
          [
            { name: 'a', data: Buffer.alloc(600) },
            { name: 'b', data: Buffer.alloc(600) },
          ],
          { maxTotalBytes: 1000 },
        ),
    ],
    [
      'entries over the scan cap',
      'entry-too-large',
      () =>
        open([{ name: 'a', data: Buffer.alloc(600) }], {
          maxScanEntryBytes: 500,
        }),
    ],
    [
      'implausible compression ratio',
      'zip-bomb',
      () => open([{ name: 'bomb', data: Buffer.alloc(64 * 1024 * 1024) }]),
    ],
  ]
  it.each(refused)('refuses %s with a reason', async (_label, code, run) => {
    expect((await refusal(run())).code).toBe(code)
  })

  it('refuses ZIP64 and multi-disk archives', async () => {
    const zip64 = buildZip([{ name: 'a' }], (eocd) =>
      eocd.writeUInt16LE(0xffff, 10),
    )
    expect((await refusal(ZipArchive.open(bufferSource(zip64)))).code).toBe(
      'zip64-unsupported',
    )
    const split = buildZip([{ name: 'a' }], (eocd) => eocd.writeUInt16LE(1, 4))
    expect((await refusal(ZipArchive.open(bufferSource(split)))).code).toBe(
      'multi-disk',
    )
  })

  it('refuses a lying entry that inflates past its declared size', async () => {
    const zip = await open([
      { name: 'liar', data: Buffer.alloc(4 * 1024 * 1024), declaredSize: 100 },
    ])
    expect((await refusal(zip.read('liar'))).code).toBe('size-mismatch')
    expect((await refusal(zip.scan('liar', 8, 8))).code).toBe('size-mismatch')
  })

  it('refuses reads over the per-entry cap and over the cumulative inflated cap', async () => {
    const zip = await open([{ name: 'a', data: Buffer.alloc(800, 1) }], {
      maxTotalBytes: 1000,
      maxEntryBytes: 900,
    })
    expect((await refusal(zip.read('a', 100))).code).toBe('entry-too-large')
    await zip.read('a')
    expect((await refusal(zip.read('a'))).code).toBe('total-too-large')
  })

  it('refuses corrupt data, bad checksums and mismatched local headers', async () => {
    const good = buildZip([
      { name: 'a.txt', data: Buffer.from('payload payload payload') },
    ])
    const corrupt = Buffer.from(good)
    corrupt[30 + 'a.txt'.length + 1] = 0xff
    corrupt[30 + 'a.txt'.length + 2] = 0xff
    const zip = await ZipArchive.open(bufferSource(corrupt))
    expect(['corrupt-entry', 'size-mismatch', 'crc-mismatch']).toContain(
      (await refusal(zip.read('a.txt'))).code,
    )
    const stored = Buffer.from(
      buildZip([{ name: 's', data: Buffer.from('abcdef'), method: 0 }]),
    )
    stored.writeUInt8(stored.readUInt8(31) ^ 0xff, 31)
    expect(
      (await refusal((await ZipArchive.open(bufferSource(stored))).read('s')))
        .code,
    ).toBe('crc-mismatch')
    const renamed = await open([
      { name: 'safe.txt', localName: 'other.txt', data: Buffer.from('x') },
    ])
    expect((await refusal(renamed.read('safe.txt'))).code).toBe(
      'local-header-mismatch',
    )
  })

  it('refuses a truncated archive', async () => {
    const good = buildZip([{ name: 'a.txt', data: Buffer.from('payload') }])
    expect(
      (
        await refusal(
          ZipArchive.open(bufferSource(good.subarray(0, good.length - 5))),
        )
      ).code,
    ).toBe('not-zip')
  })
})
