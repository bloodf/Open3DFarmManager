import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { crc32, createInflateRaw, inflateRawSync } from 'node:zlib'

/** A random-access byte source. read must return at most length bytes from offset. */
export interface ZipSource {
  size: number
  read(offset: number, length: number): Promise<Uint8Array>
}

export interface ZipLimits {
  /** Entries in the central directory. */
  maxEntries: number
  /** Entry name length in bytes. */
  maxNameLength: number
  /** Inflated size of one entry loaded in memory by read(). */
  maxEntryBytes: number
  /** Inflated size of one entry processed by scan(), which never holds it in memory. */
  maxScanEntryBytes: number
  /** Sum of declared inflated sizes, and of bytes actually inflated by this reader. */
  maxTotalBytes: number
  /** Largest accepted inflated/compressed ratio for entries above 1 MiB. */
  maxCompressionRatio: number
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 1024,
  maxNameLength: 255,
  maxEntryBytes: 64 * 1024 * 1024,
  maxScanEntryBytes: 1024 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
  maxCompressionRatio: 200,
}

export type ZipErrorCode =
  | 'not-zip'
  | 'zip64-unsupported'
  | 'multi-disk'
  | 'too-many-entries'
  | 'central-directory-invalid'
  | 'central-directory-too-large'
  | 'name-too-long'
  | 'invalid-name'
  | 'path-traversal'
  | 'duplicate-entry'
  | 'encrypted'
  | 'unsupported-method'
  | 'entry-too-large'
  | 'total-too-large'
  | 'zip-bomb'
  | 'local-header-mismatch'
  | 'truncated'
  | 'corrupt-entry'
  | 'size-mismatch'
  | 'crc-mismatch'
  | 'entry-not-found'

/** A refused archive. code is stable for callers, message is a pt-BR reason. */
export class ZipError extends Error {
  readonly code: ZipErrorCode
  constructor(code: ZipErrorCode, message: string) {
    super(message)
    this.name = 'ZipError'
    this.code = code
  }
}

export interface ZipEntryInfo {
  readonly name: string
  readonly compressedSize: number
  readonly uncompressedSize: number
  readonly method: 0 | 8
  readonly crc32: number
  readonly directory: boolean
  readonly localOffset: number
}

export interface ZipScan {
  size: number
  /** First bytes of the inflated entry (all of it when small). */
  head: Uint8Array
  /** Last bytes of the inflated entry (may overlap head). */
  tail: Uint8Array
}

export function bufferSource(data: Uint8Array): ZipSource {
  return {
    size: data.byteLength,
    read: async (offset, length) => data.subarray(offset, offset + length),
  }
}

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const EOCD_MIN = 22
const MAX_COMMENT = 0xffff
const CENTRAL_HEADER = 46
const LOCAL_HEADER = 30
const MAX_CENTRAL_DIRECTORY = 4 * 1024 * 1024
const RATIO_FLOOR = 1024 * 1024
const CHUNK = 64 * 1024

async function readExact(
  source: ZipSource,
  offset: number,
  length: number,
): Promise<Buffer> {
  if (length === 0) return Buffer.alloc(0)
  const bytes = await source.read(offset, length)
  if (bytes.byteLength !== length)
    throw new ZipError('truncated', 'O arquivo ZIP está truncado.')
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function validateName(name: string): void {
  if (name.length === 0 || name.includes('\0') || name.includes('\\')) {
    throw new ZipError(
      'invalid-name',
      'O arquivo ZIP contém um nome de entrada inválido.',
    )
  }
  if (
    name.startsWith('/') ||
    /^[A-Za-z]:/.test(name) ||
    name.split('/').some((part) => part === '..' || part === '.')
  ) {
    throw new ZipError(
      'path-traversal',
      `A entrada "${name.slice(0, 80)}" tenta sair do diretório do projeto.`,
    )
  }
}

export class ZipArchive {
  readonly entries: readonly ZipEntryInfo[]
  private readonly byKey: ReadonlyMap<string, ZipEntryInfo>
  private inflated = 0
  private readonly source: ZipSource
  private readonly limits: ZipLimits
  private readonly centralOffset: number

  // No parameter properties: the Connector runs this file under Node's
  // type-stripping, which does not support them.
  private constructor(
    source: ZipSource,
    limits: ZipLimits,
    centralOffset: number,
    entries: ZipEntryInfo[],
  ) {
    this.source = source
    this.limits = limits
    this.centralOffset = centralOffset
    this.entries = entries
    this.byKey = new Map(
      entries.map((entry) => [entry.name.toLowerCase(), entry]),
    )
  }

  /** Reads and validates only the central directory. No entry is inflated. */
  static async open(
    source: ZipSource,
    overrides: Partial<ZipLimits> = {},
  ): Promise<ZipArchive> {
    const limits = { ...DEFAULT_ZIP_LIMITS, ...overrides }
    if (!Number.isSafeInteger(source.size) || source.size < EOCD_MIN)
      throw new ZipError('not-zip', 'O arquivo não é um ZIP válido.')
    const window = Math.min(source.size, EOCD_MIN + MAX_COMMENT)
    const tail = await readExact(source, source.size - window, window)
    let eocd = -1
    for (let i = tail.length - EOCD_MIN; i >= 0; i--) {
      if (
        tail.readUInt32LE(i) === EOCD_SIGNATURE &&
        i + EOCD_MIN + tail.readUInt16LE(i + 20) === tail.length
      ) {
        eocd = i
        break
      }
    }
    if (eocd < 0)
      throw new ZipError('not-zip', 'O arquivo não é um ZIP válido.')
    const eocdOffset = source.size - window + eocd
    const disk = tail.readUInt16LE(eocd + 4)
    const cdDisk = tail.readUInt16LE(eocd + 6)
    const onDisk = tail.readUInt16LE(eocd + 8)
    const total = tail.readUInt16LE(eocd + 10)
    const cdSize = tail.readUInt32LE(eocd + 12)
    const cdOffset = tail.readUInt32LE(eocd + 16)
    if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff)
      throw new ZipError('zip64-unsupported', 'ZIP64 não é suportado.')
    if (disk !== 0 || cdDisk !== 0 || onDisk !== total)
      throw new ZipError('multi-disk', 'ZIP em vários volumes não é suportado.')
    if (total > limits.maxEntries)
      throw new ZipError(
        'too-many-entries',
        `O ZIP tem ${total} entradas; o limite é ${limits.maxEntries}.`,
      )
    if (cdSize > MAX_CENTRAL_DIRECTORY)
      throw new ZipError(
        'central-directory-too-large',
        'O diretório central do ZIP é grande demais.',
      )
    if (cdOffset + cdSize > eocdOffset)
      throw new ZipError(
        'central-directory-invalid',
        'O diretório central do ZIP é inválido.',
      )
    const central = await readExact(source, cdOffset, cdSize)
    return new ZipArchive(
      source,
      limits,
      cdOffset,
      parseCentral(central, total, cdOffset, limits),
    )
  }

  get(name: string): ZipEntryInfo | undefined {
    return this.byKey.get(name.toLowerCase())
  }

  has(name: string): boolean {
    return this.byKey.has(name.toLowerCase())
  }

  /** Inflates a whole entry in memory, never producing more bytes than it declares. */
  async read(
    name: string,
    maxBytes = this.limits.maxEntryBytes,
  ): Promise<Uint8Array> {
    const entry = this.require(name)
    const cap = Math.min(maxBytes, this.limits.maxEntryBytes)
    if (entry.uncompressedSize > cap || entry.compressedSize > cap) {
      throw new ZipError(
        'entry-too-large',
        `A entrada "${entry.name}" excede o limite de ${cap} bytes.`,
      )
    }
    this.charge(entry)
    const raw = await readExact(
      this.source,
      await this.dataOffset(entry),
      entry.compressedSize,
    )
    let data: Buffer
    if (entry.method === 0) data = raw
    else if (entry.uncompressedSize === 0) data = Buffer.alloc(0)
    else {
      try {
        data = inflateRawSync(raw, { maxOutputLength: entry.uncompressedSize })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
          throw new ZipError(
            'size-mismatch',
            `A entrada "${entry.name}" descompacta além do tamanho declarado.`,
          )
        }
        throw new ZipError(
          'corrupt-entry',
          `A entrada "${entry.name}" está corrompida.`,
        )
      }
    }
    if (data.length !== entry.uncompressedSize)
      throw new ZipError(
        'size-mismatch',
        `A entrada "${entry.name}" não tem o tamanho declarado.`,
      )
    if (crc32(data) !== entry.crc32)
      throw new ZipError(
        'crc-mismatch',
        `A entrada "${entry.name}" falhou na verificação de integridade.`,
      )
    return data
  }

  /**
   * Streams an entry through the inflater keeping only its first headBytes and
   * last tailBytes. Memory stays bounded however large the entry is.
   */
  async scan(
    name: string,
    headBytes: number,
    tailBytes: number,
  ): Promise<ZipScan> {
    const entry = this.require(name)
    if (entry.uncompressedSize > this.limits.maxScanEntryBytes) {
      throw new ZipError(
        'entry-too-large',
        `A entrada "${entry.name}" excede o limite de ${this.limits.maxScanEntryBytes} bytes.`,
      )
    }
    this.charge(entry)
    const start = await this.dataOffset(entry)
    const head: Buffer[] = []
    let headLength = 0
    const tail: Buffer[] = []
    let tailLength = 0
    let produced = 0
    let crc = 0
    const sink = new Writable({
      write: (chunk: Buffer, _encoding, done) => {
        produced += chunk.length
        if (produced > entry.uncompressedSize)
          return done(
            new ZipError(
              'size-mismatch',
              `A entrada "${entry.name}" descompacta além do tamanho declarado.`,
            ),
          )
        crc = crc32(chunk, crc)
        if (headLength < headBytes) {
          const piece = chunk.subarray(0, headBytes - headLength)
          head.push(piece)
          headLength += piece.length
        }
        tail.push(chunk)
        tailLength += chunk.length
        while (tail.length > 1 && tailLength - tail[0]!.length >= tailBytes)
          tailLength -= tail.shift()!.length
        done()
      },
    })
    const source = this.source
    const compressed = (async function* () {
      for (let offset = 0; offset < entry.compressedSize; offset += CHUNK) {
        yield await readExact(
          source,
          start + offset,
          Math.min(CHUNK, entry.compressedSize - offset),
        )
      }
    })()
    try {
      const stages =
        entry.method === 0
          ? [Readable.from(compressed), sink]
          : [Readable.from(compressed), createInflateRaw(), sink]
      await pipeline(stages as [Readable, ...Writable[]])
    } catch (error) {
      if (error instanceof ZipError) throw error
      throw new ZipError(
        'corrupt-entry',
        `A entrada "${entry.name}" está corrompida.`,
      )
    }
    if (produced !== entry.uncompressedSize)
      throw new ZipError(
        'size-mismatch',
        `A entrada "${entry.name}" não tem o tamanho declarado.`,
      )
    if (crc !== entry.crc32)
      throw new ZipError(
        'crc-mismatch',
        `A entrada "${entry.name}" falhou na verificação de integridade.`,
      )
    const all = Buffer.concat(tail)
    return {
      size: produced,
      head: Buffer.concat(head),
      tail: all.subarray(Math.max(0, all.length - tailBytes)),
    }
  }

  private require(name: string): ZipEntryInfo {
    const entry = this.get(name)
    if (!entry || entry.directory)
      throw new ZipError(
        'entry-not-found',
        `A entrada "${name.slice(0, 80)}" não existe no ZIP.`,
      )
    return entry
  }

  private charge(entry: ZipEntryInfo): void {
    if (this.inflated + entry.uncompressedSize > this.limits.maxTotalBytes) {
      throw new ZipError(
        'total-too-large',
        'O conteúdo descompactado do ZIP excede o limite total.',
      )
    }
    this.inflated += entry.uncompressedSize
  }

  private async dataOffset(entry: ZipEntryInfo): Promise<number> {
    const header = await readExact(this.source, entry.localOffset, LOCAL_HEADER)
    if (header.readUInt32LE(0) !== LOCAL_SIGNATURE)
      throw new ZipError(
        'local-header-mismatch',
        `O cabeçalho local de "${entry.name}" é inválido.`,
      )
    const nameLength = header.readUInt16LE(26)
    const extraLength = header.readUInt16LE(28)
    const localName = await readExact(
      this.source,
      entry.localOffset + LOCAL_HEADER,
      nameLength,
    )
    if (localName.toString('utf8') !== entry.name)
      throw new ZipError(
        'local-header-mismatch',
        `O cabeçalho local de "${entry.name}" não confere com o diretório central.`,
      )
    const offset = entry.localOffset + LOCAL_HEADER + nameLength + extraLength
    if (offset + entry.compressedSize > this.centralOffset)
      throw new ZipError(
        'truncated',
        `Os dados de "${entry.name}" ultrapassam o diretório central.`,
      )
    return offset
  }
}

function parseCentral(
  central: Buffer,
  total: number,
  centralOffset: number,
  limits: ZipLimits,
): ZipEntryInfo[] {
  const entries: ZipEntryInfo[] = []
  const seen = new Set<string>()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let declared = 0
  let cursor = 0
  for (let index = 0; index < total; index++) {
    if (
      cursor + CENTRAL_HEADER > central.length ||
      central.readUInt32LE(cursor) !== CENTRAL_SIGNATURE
    ) {
      throw new ZipError(
        'central-directory-invalid',
        'O diretório central do ZIP é inválido.',
      )
    }
    const flags = central.readUInt16LE(cursor + 8)
    const method = central.readUInt16LE(cursor + 10)
    const crc = central.readUInt32LE(cursor + 16)
    const compressedSize = central.readUInt32LE(cursor + 20)
    const uncompressedSize = central.readUInt32LE(cursor + 24)
    const nameLength = central.readUInt16LE(cursor + 28)
    const extraLength = central.readUInt16LE(cursor + 30)
    const commentLength = central.readUInt16LE(cursor + 32)
    const localOffset = central.readUInt32LE(cursor + 42)
    const next =
      cursor + CENTRAL_HEADER + nameLength + extraLength + commentLength
    if (nameLength > limits.maxNameLength)
      throw new ZipError(
        'name-too-long',
        `Um nome de entrada excede ${limits.maxNameLength} bytes.`,
      )
    if (next > central.length)
      throw new ZipError(
        'central-directory-invalid',
        'O diretório central do ZIP é inválido.',
      )
    let name: string
    try {
      name = decoder.decode(
        central.subarray(
          cursor + CENTRAL_HEADER,
          cursor + CENTRAL_HEADER + nameLength,
        ),
      )
    } catch {
      throw new ZipError(
        'invalid-name',
        'O arquivo ZIP contém um nome de entrada inválido.',
      )
    }
    validateName(name)
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff
    )
      throw new ZipError('zip64-unsupported', 'ZIP64 não é suportado.')
    if (flags & 1)
      throw new ZipError('encrypted', `A entrada "${name}" é criptografada.`)
    if (method !== 0 && method !== 8)
      throw new ZipError(
        'unsupported-method',
        `A entrada "${name}" usa um método de compressão não suportado.`,
      )
    const key = name.toLowerCase()
    if (seen.has(key))
      throw new ZipError(
        'duplicate-entry',
        `A entrada "${name}" aparece mais de uma vez.`,
      )
    seen.add(key)
    const directory = name.endsWith('/')
    if (directory && uncompressedSize !== 0)
      throw new ZipError('invalid-name', `O diretório "${name}" contém dados.`)
    if (method === 0 && compressedSize !== uncompressedSize)
      throw new ZipError(
        'size-mismatch',
        `A entrada "${name}" tem tamanhos inconsistentes.`,
      )
    if (uncompressedSize > limits.maxScanEntryBytes)
      throw new ZipError(
        'entry-too-large',
        `A entrada "${name}" excede o limite de ${limits.maxScanEntryBytes} bytes.`,
      )
    declared += uncompressedSize
    if (declared > limits.maxTotalBytes)
      throw new ZipError(
        'total-too-large',
        'O conteúdo descompactado do ZIP excede o limite total.',
      )
    if (
      uncompressedSize > RATIO_FLOOR &&
      uncompressedSize > compressedSize * limits.maxCompressionRatio
    ) {
      throw new ZipError(
        'zip-bomb',
        `A entrada "${name}" tem taxa de compressão suspeita.`,
      )
    }
    if (localOffset + LOCAL_HEADER > centralOffset)
      throw new ZipError(
        'central-directory-invalid',
        `A entrada "${name}" aponta para fora do arquivo.`,
      )
    entries.push({
      name,
      compressedSize,
      uncompressedSize,
      method,
      crc32: crc,
      directory,
      localOffset,
    })
    cursor = next
  }
  return entries
}
