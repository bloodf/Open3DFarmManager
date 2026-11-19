import { readThreeMf } from '../../../../../packages/shared/src/print-file/3mf-meta.ts'
import type { ThreeMfProject } from '../../../../../packages/shared/src/print-file/3mf-meta.ts'
import {
  PrintFileMetadata,
  readLibraryGcodeMetadata,
} from '../../../../../packages/shared/src/print-file/metadata.ts'
import type { BlobStore } from './blob-store.ts'

/** Random-access reads over a stored file; shared shape of the E17.2 and E17.3 parsers. */
export interface RangeSource {
  size: number
  read(offset: number, length: number): Promise<Uint8Array>
}

/** Metadata above this many base64 characters would break the 512 KiB row limit. */
const MAX_THUMBNAIL_CHARS = 300_000

export type IngestResult =
  | { ok: true; metadata: PrintFileMetadata; plateCount: number }
  | { ok: false; reason: string }

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}

export function blobSource(
  blobs: Pick<BlobStore, 'read'>,
  sha256: string,
  size: number,
): RangeSource {
  return {
    size,
    async read(offset, length) {
      const end = Math.min(size - 1, offset + length - 1)
      if (length <= 0 || offset >= size) return new Uint8Array()
      const { stream } = await blobs.read(sha256, { start: offset, end })
      return collect(stream)
    },
  }
}

/** Drops undefined entries (zod output, optional fields) so exact optional types hold. */
export const defined = <T extends object>(
  value: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } =>
  Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as { [K in keyof T]?: Exclude<T[K], undefined> }

/** One plate drives the card: the first startable one, else the first. */
function threeMfMetadata(project: ThreeMfProject): PrintFileMetadata {
  const plate = project.plates.find((p) => p.startable) ?? project.plates[0]
  const nozzle = project.nozzleDiameter ?? plate?.nozzleDiameter
  const tools = project.filaments.map((f) =>
    defined({
      nozzleDiameter: nozzle,
      filamentType: f.type,
      filamentColour: f.colour,
      filamentGrams:
        f.usedGrams ?? plate?.filaments.find((x) => x.id === f.id)?.usedGrams,
    }),
  )
  return {
    ...plate?.gcode,
    ...defined({
      slicer: project.slicer,
      slicerVersion: project.slicerVersion,
      printerModel: project.printerModel,
      printerProfile: project.printerProfile,
      estimatedTimeSeconds: plate?.estimatedTimeSeconds,
      thumbnail: plate?.thumbnail,
      objectCount: plate?.objects.filter((o) => !o.skipped).length,
    }),
    ...(tools.length
      ? { tools }
      : nozzle !== undefined
        ? { tools: [{ nozzleDiameter: nozzle }] }
        : {}),
  }
}

/** Parses a stored file with the E17.2 (G-code) or E17.3 (3MF) reader. */
export async function ingest(
  kind: 'gcode' | '3mf',
  source: RangeSource,
): Promise<IngestResult> {
  let raw: PrintFileMetadata
  let plateCount = 1
  if (kind === 'gcode') raw = await readLibraryGcodeMetadata(source)
  else {
    const result = await readThreeMf(source)
    if (!result.ok) return { ok: false, reason: result.reason }
    raw = threeMfMetadata(result.project)
    plateCount = result.project.plates.length
  }
  const { thumbnail, ...rest } = raw
  const parsed = PrintFileMetadata.safeParse(
    thumbnail && thumbnail.data.length > MAX_THUMBNAIL_CHARS ? rest : raw,
  )
  if (!parsed.success)
    return { ok: false, reason: 'Os metadados do arquivo são inválidos.' }
  return { ok: true, metadata: parsed.data, plateCount }
}
