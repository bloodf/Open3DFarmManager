import { checkCompatibility } from '../../../../packages/shared/src/print-file/compatibility.ts'

export type StorageMode = 'server' | 'connector'
export type LibraryTool = {
  nozzleDiameter?: number
  filamentType?: string
  filamentColour?: string
  filamentGrams?: number
}
export type LibraryMetadata = {
  slicer?: string
  slicerVersion?: string
  printerModel?: string
  tools?: LibraryTool[]
  estimatedTimeSeconds?: number
  layerHeight?: number
  objectCount?: number
  totalLayers?: number
}
export type LibraryVersion = {
  id: string
  itemId: string
  versionNumber: number
  sha256: string
  sizeBytes: number
  storageLocation: StorageMode
  agentId: string | null
  originalName: string
  kind: 'gcode' | '3mf'
  plateCount: number
  metadata: LibraryMetadata
  hasThumbnail: boolean
  notes: string
  createdAt: number
  deletedAt: number | null
  purgedAt: number | null
}
export type LibraryItem = {
  id: string
  title: string
  tags: string[]
  archived: boolean
  createdAt: number
  latest: LibraryVersion
}
export type LibraryLocation = {
  location: StorageMode
  agentId: string | null
  files: number
  bytes: number
}
export type LibraryFilters = {
  title: string
  printerModel: string
  nozzle: string
  material: string
  tag: string
}
export type PrinterProfile = {
  assignmentId: string
  effective: {
    values: { model: string | null; nozzleDiameterMm: number | null }
    compatibleModels: string[]
  }
}

export const emptyFilters: LibraryFilters = {
  title: '',
  printerModel: '',
  nozzle: '',
  material: '',
  tag: '',
}

/** Server query for the filters the API supports; blank fields are left out. */
export function filterQuery(
  filters: LibraryFilters,
  cursor?: string,
): Record<string, string> {
  const query: Record<string, string> = {}
  for (const [key, value] of Object.entries(filters)) {
    const text = value.trim()
    if (text) query[key] = text
  }
  if (cursor) query.cursor = cursor
  return query
}

/** Returns an error for a nozzle that is not a positive number up to 10 mm. */
export function nozzleError(value: string): string | undefined {
  if (!value.trim()) return undefined
  const n = Number(value.replace(',', '.'))
  return Number.isFinite(n) && n > 0 && n <= 10
    ? undefined
    : 'Informe um diâmetro entre 0,1 e 10 mm.'
}

export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined) return 'não informado'
  const minutes = Math.round(seconds / 60)
  const hours = Math.floor(minutes / 60)
  return hours ? `${hours} h ${minutes % 60} min` : `${minutes} min`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let unit = -1
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(1).replace('.', ',')} ${units[unit]}`
}

export function totalGrams(metadata: LibraryMetadata): number | undefined {
  const grams = (metadata.tools ?? []).flatMap((tool) =>
    tool.filamentGrams === undefined ? [] : [tool.filamentGrams],
  )
  return grams.length
    ? Math.round(grams.reduce((sum, g) => sum + g, 0) * 10) / 10
    : undefined
}

export const nozzles = (metadata: LibraryMetadata): number[] => [
  ...new Set(
    (metadata.tools ?? []).flatMap((tool) =>
      tool.nozzleDiameter === undefined ? [] : [tool.nozzleDiameter],
    ),
  ),
]

export const materials = (metadata: LibraryMetadata) =>
  (metadata.tools ?? []).flatMap((tool) =>
    tool.filamentType || tool.filamentColour
      ? [{ type: tool.filamentType, colour: tool.filamentColour }]
      : [],
  )

/** Only a six-digit hex colour is painted; the text is always shown too. */
export const safeColour = (colour: string | undefined) =>
  colour && /^#[0-9a-f]{6}$/i.test(colour) ? colour : undefined

export const locationLabel = (mode: StorageMode) =>
  mode === 'connector' ? 'Connector' : 'Servidor'

export function versionStatus(version: LibraryVersion): string {
  if (version.purgedAt !== null) return 'arquivo removido'
  if (version.deletedAt !== null) return 'excluída'
  return 'disponível'
}

/** "Compatível com": hides only the files the printer's profile blocks. */
export function compatibleWith(
  items: readonly LibraryItem[],
  profile: PrinterProfile | undefined,
): LibraryItem[] {
  const { model, nozzleDiameterMm } = profile?.effective.values ?? {}
  if (!profile || !model) return [...items]
  return items.filter(({ latest }) => {
    const result = checkCompatibility(
      { ...latest.metadata, format: latest.kind },
      {
        model,
        compatibleModels: profile.effective.compatibleModels,
        nozzleDiameters: nozzleDiameterMm == null ? [] : [nozzleDiameterMm],
      },
      [],
    )
    // Without a known nozzle the profile cannot judge it: only model blocks.
    return (
      result.level !== 'block' ||
      (nozzleDiameterMm == null &&
        result.reasons.every(
          (r) => r.level !== 'block' || /ferramenta/i.test(r.message),
        ))
    )
  })
}

export function validateLibraryUpload(file: {
  name: string
  size: number
}): string | undefined {
  if (!/\.(gcode|3mf)$/i.test(file.name))
    return 'Selecione um arquivo .gcode ou .3mf.'
  if (
    !Number.isSafeInteger(file.size) ||
    file.size <= 0 ||
    file.size > 512 * 1024 * 1024
  )
    return 'O arquivo deve ter entre 1 byte e 512 MiB.'
  return undefined
}

export type UploadInput = {
  farmId: string
  file: File
  title: string
  tags: string[]
  notes: string
  itemId?: string
  agentId?: string
}

/** fetch has no upload progress, so the bytes go through XMLHttpRequest. */
export function uploadFile(
  input: UploadInput,
  onProgress: (fraction: number) => void,
  xhr: XMLHttpRequest = new XMLHttpRequest(),
): Promise<{ version: LibraryVersion; deduplicated: boolean }> {
  const params = new URLSearchParams({ name: input.file.name })
  if (input.title.trim()) params.set('title', input.title.trim())
  if (input.itemId) params.set('itemId', input.itemId)
  if (input.agentId) params.set('agentId', input.agentId)
  if (input.notes.trim()) params.set('notes', input.notes.trim())
  for (const tag of input.tags) params.append('tag', tag)
  return new Promise((resolve, reject) => {
    xhr.open('POST', `/api/farms/${input.farmId}/library?${params}`)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total)
    }
    xhr.onerror = () => reject(new Error('Falha de rede durante o envio.'))
    xhr.onabort = () => reject(new Error('Envio cancelado.'))
    xhr.onload = () => {
      let body: { message?: string } | undefined
      try {
        body = JSON.parse(xhr.responseText)
      } catch {
        body = undefined
      }
      if (xhr.status === 201)
        resolve(body as { version: LibraryVersion; deduplicated: boolean })
      else reject(new Error('Não foi possível enviar o arquivo.'))
    }
    xhr.send(input.file)
  })
}
