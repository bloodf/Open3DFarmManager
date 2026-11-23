// SPDX-License-Identifier: MIT
import { formatNumber } from '../../utils/ui-format.ts'
/**
 * Pure helpers of the bed mesh panel: statistics, colour scale, the 3D
 * projection drawn on a canvas (no library), the accessible table model and
 * the command request. Nothing here touches the DOM except `drawHeightmap`,
 * which only calls the 2D context it is given.
 */
import { MeshProfileName } from '../../../../../packages/farm-protocol/src/control-actions.ts'

export type MeshRows = readonly (readonly number[])[]
export type BedMeshData = Readonly<{
  profile: string | null
  min: readonly [number, number]
  max: readonly [number, number]
  /** Interpolated matrix: what Klipper compensates with. */
  rows: MeshRows
  /** Probed points, when the printer reports them. */
  probed?: MeshRows
  /** Saved profile names. */
  profiles?: readonly string[]
}>
export type MeshSource = 'interpolated' | 'probed'
export type MeshOp = 'calibrate' | 'load' | 'save' | 'remove' | 'clear'
export type MeshAvailability = Readonly<{ available: boolean; reason?: string }>
export type MeshAvailabilityMap = Readonly<
  Partial<Record<MeshOp, MeshAvailability>>
>
export type MeshStats = Readonly<{
  min: number
  max: number
  range: number
  columns: number
  rows: number
}>

export const DEFAULT_MESH_REASON = 'Comando indisponível.'

const number = (value: number, digits = 3) =>
  formatNumber(value, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
export const meshMm = (value: number) => `${number(value)} mm`

/** The matrix to show; the probed one only when it exists. */
export function meshRowsFor(
  mesh: BedMeshData | undefined,
  source: MeshSource,
): MeshRows {
  if (!mesh) return []
  return source === 'probed' && mesh.probed?.length ? mesh.probed : mesh.rows
}

/** Minimum, maximum and range over the finite points; undefined for an empty mesh. */
export function meshStats(rows: MeshRows): MeshStats | undefined {
  const values = rows.flat().filter(Number.isFinite)
  if (!values.length) return undefined
  const min = Math.min(...values)
  const max = Math.max(...values)
  return {
    min,
    max,
    range: max - min,
    columns: Math.max(...rows.map((row) => row.length)),
    rows: rows.length,
  }
}

/** Viridis-like stops: dark blue (low) to yellow (high), readable without hue alone. */
const STOPS: readonly (readonly [number, number, number])[] = [
  [68, 1, 84],
  [59, 82, 139],
  [33, 144, 141],
  [93, 200, 99],
  [253, 231, 37],
]
export const SCALE_STOPS = STOPS.map(([r, g, b]) => `rgb(${r}, ${g}, ${b})`)

/** Colour of a value on the scale; a flat mesh uses the middle colour. */
export function meshColor(value: number, min: number, max: number): string {
  const t =
    !Number.isFinite(value) || max <= min
      ? 0.5
      : Math.min(1, Math.max(0, (value - min) / (max - min)))
  const scaled = t * (STOPS.length - 1)
  const index = Math.min(STOPS.length - 2, Math.floor(scaled))
  const mix = scaled - index
  const from = STOPS[index]!
  const to = STOPS[index + 1]!
  const [r, g, b] = from.map((channel, i) =>
    Math.round(channel + (to[i]! - channel) * mix),
  )
  return `rgb(${r}, ${g}, ${b})`
}

export type View = Readonly<{ yaw: number; pitch: number }>
export const DEFAULT_VIEW: View = { yaw: -35, pitch: 45 }
export const VIEW_STEP_DEG = 15
const PITCH_MIN = 5
const PITCH_MAX = 90

/** Rotates the view by degrees; yaw wraps, pitch stays between side and top view. */
export function rotateView(view: View, dYaw: number, dPitch: number): View {
  const yaw = ((((view.yaw + dYaw + 180) % 360) + 360) % 360) - 180
  const pitch = Math.min(PITCH_MAX, Math.max(PITCH_MIN, view.pitch + dPitch))
  return { yaw, pitch }
}

export type Quad = Readonly<{
  points: readonly (readonly [number, number])[]
  fill: string
  depth: number
}>

const RADIANS = Math.PI / 180
/** Share of the plane width the height range spans, so small warps stay visible. */
const HEIGHT_EXAGGERATION = 0.3

/**
 * Orthographic projection of the mesh into canvas pixels: one quad per cell,
 * sorted far to near (painter's algorithm). A mesh needs at least 2×2 points.
 */
export function projectMesh(
  rows: MeshRows,
  bounds: Pick<BedMeshData, 'min' | 'max'>,
  view: View,
  size: Readonly<{ width: number; height: number }>,
): Quad[] {
  const stats = meshStats(rows)
  const columns = stats?.columns ?? 0
  if (!stats || rows.length < 2 || columns < 2) return []
  const spanX = Math.abs(bounds.max[0] - bounds.min[0]) || 1
  const spanY = Math.abs(bounds.max[1] - bounds.min[1]) || 1
  const longest = Math.max(spanX, spanY)
  const middle = (stats.min + stats.max) / 2
  const yaw = view.yaw * RADIANS
  const pitch = view.pitch * RADIANS
  const scale = (Math.min(size.width, size.height) / 1.5) * 0.95
  const point = (column: number, row: number) => {
    const value = rows[row]?.[column]
    const x = (column / (columns - 1) - 0.5) * (spanX / longest)
    const y = (row / (rows.length - 1) - 0.5) * (spanY / longest)
    const z =
      stats.range > 0 && value !== undefined && Number.isFinite(value)
        ? ((value - middle) / stats.range) * HEIGHT_EXAGGERATION
        : 0
    const rx = x * Math.cos(yaw) - y * Math.sin(yaw)
    const ry = x * Math.sin(yaw) + y * Math.cos(yaw)
    const up = z * Math.cos(pitch) + ry * Math.sin(pitch)
    return {
      px: size.width / 2 + rx * scale,
      py: size.height / 2 - up * scale,
      depth: ry * Math.cos(pitch) - z * Math.sin(pitch),
      value,
    }
  }
  const quads: Quad[] = []
  for (let row = 0; row < rows.length - 1; row++) {
    for (let column = 0; column < columns - 1; column++) {
      const corners = [
        point(column, row),
        point(column + 1, row),
        point(column + 1, row + 1),
        point(column, row + 1),
      ]
      const values = corners
        .map(({ value }) => value)
        .filter((value): value is number => Number.isFinite(value))
      if (values.length < 4) continue
      quads.push({
        points: corners.map(({ px, py }) => [px, py] as const),
        fill: meshColor(
          values.reduce((sum, value) => sum + value, 0) / 4,
          stats.min,
          stats.max,
        ),
        depth: corners.reduce((sum, { depth }) => sum + depth, 0) / 4,
      })
    }
  }
  return quads.sort((a, b) => b.depth - a.depth)
}

/** The 2D calls `drawHeightmap` needs; a real CanvasRenderingContext2D satisfies it. */
export type HeightmapContext = Pick<
  CanvasRenderingContext2D,
  | 'clearRect'
  | 'beginPath'
  | 'moveTo'
  | 'lineTo'
  | 'closePath'
  | 'fill'
  | 'stroke'
  | 'fillStyle'
  | 'strokeStyle'
  | 'lineWidth'
>

/** Paints the quads far to near with a thin outline; returns how many were drawn. */
export function drawHeightmap(
  context: HeightmapContext,
  quads: readonly Quad[],
  size: Readonly<{ width: number; height: number }>,
): number {
  context.clearRect(0, 0, size.width, size.height)
  context.lineWidth = 0.5
  context.strokeStyle = 'rgba(0, 0, 0, 0.35)'
  for (const quad of quads) {
    context.beginPath()
    quad.points.forEach(([x, y], index) =>
      index ? context.lineTo(x, y) : context.moveTo(x, y),
    )
    context.closePath()
    context.fillStyle = quad.fill
    context.fill()
    context.stroke()
  }
  return quads.length
}

export type MeshCell = Readonly<{ value: number; text: string; fill: string }>
export type MeshTable = Readonly<{
  /** X coordinates in mm, one per column. */
  columns: readonly string[]
  rows: readonly Readonly<{ label: string; cells: readonly MeshCell[] }>[]
}>

const along = (from: number, to: number, count: number, index: number) =>
  count < 2 ? from : from + ((to - from) * index) / (count - 1)

/** Table and flat colour grid model; rows run front (low Y) to back. */
export function meshTable(
  rows: MeshRows,
  bounds: Pick<BedMeshData, 'min' | 'max'>,
): MeshTable | undefined {
  const stats = meshStats(rows)
  if (!stats) return undefined
  return {
    columns: Array.from({ length: stats.columns }, (_, column) =>
      number(along(bounds.min[0], bounds.max[0], stats.columns, column), 1),
    ),
    rows: rows.map((row, index) => ({
      label: number(along(bounds.min[1], bounds.max[1], rows.length, index), 1),
      cells: row.map((value) => ({
        value,
        text: Number.isFinite(value) ? number(value) : '—',
        fill: meshColor(value, stats.min, stats.max),
      })),
    })),
  }
}

/** One-sentence summary for screen readers and the legend. */
export function meshSummary(
  rows: MeshRows,
  source: MeshSource,
  profile: string | null,
): string {
  const stats = meshStats(rows)
  if (!stats) return 'Sem malha de mesa disponível.'
  return `Malha ${source === 'probed' ? 'sondada' : 'interpolada'} de ${stats.columns} por ${stats.rows} pontos${
    profile ? `, perfil ${profile}` : ''
  }. Mínimo ${meshMm(stats.min)}, máximo ${meshMm(stats.max)}, variação ${meshMm(stats.range)}.`
}

/** Profile name for a command, or a pt-BR note when it is not usable. */
export function profileName(
  input: string,
  required: boolean,
): { profile?: string } | { note: string } {
  const text = input.trim()
  if (!text) return required ? { note: 'Informe o nome do perfil.' } : {}
  return MeshProfileName.safeParse(text).success
    ? { profile: text }
    : {
        note: 'Use de 1 a 32 letras sem acento, números ou sublinhado no nome do perfil.',
      }
}

/** Arguments of the signed bed_mesh command; `clear` never carries a profile. */
export function meshRequest(
  op: MeshOp,
  input: string,
): { args: { op: MeshOp; profile?: string } } | { note: string } {
  if (op === 'clear') return { args: { op } }
  const named = profileName(input, op !== 'calibrate')
  if ('note' in named) return named
  return { args: { op, ...named } }
}
