/** Upstream `spoolman/math.py` color similarity and `tags.normalize_uid`. */

/** Python `int(text, 16)`; `null` where Python raises. */
function pyHex(text: string): number | null {
  if (!/^\s*[+-]?[0-9a-fA-F](_?[0-9a-fA-F])*\s*$/.test(text)) return null
  return parseInt(text.trim().replaceAll('_', ''), 16)
}

/** Upstream `hex_to_rgb`; `null` where it would raise (an HTTP 500 upstream). */
export function hexToRgb(hex: string): [number, number, number] | null {
  const code = hex.replace(/^#+/, '')
  const parts = [code.slice(0, 2), code.slice(2, 4), code.slice(4, 6)].map(
    pyHex,
  )
  return parts.every((p) => p !== null)
    ? (parts as [number, number, number])
    : null
}

export function rgbToLab([r8, g8, b8]: [number, number, number]): [
  number,
  number,
  number,
] {
  const lin = (c: number) =>
    c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  const r = lin(r8 / 255)
  const g = lin(g8 / 255)
  const b = lin(b8 / 255)
  const f = (t: number) =>
    t > 0.008856 ? Math.pow(t, 1 / 3) : 7.787 * t + 16 / 116
  const x = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047)
  const y = f((r * 0.2126 + g * 0.7152 + b * 0.0722) / 1.0)
  const z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883)
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)]
}

/** CIE94 difference as upstream `delta_e`. */
export function deltaE(
  a: [number, number, number],
  b: [number, number, number],
): number {
  const dl = a[0] - b[0]
  const da = a[1] - b[1]
  const db = a[2] - b[2]
  const c1 = Math.sqrt(a[1] * a[1] + a[2] * a[2])
  const c2 = Math.sqrt(b[1] * b[1] + b[2] * b[2])
  const dc = c1 - c2
  let dh = da * da + db * db - dc * dc
  dh = dh > 0 ? Math.sqrt(dh) : 0
  const sc = 1 + 0.045 * c1
  const sh = 1 + 0.015 * c1
  const i = dl * dl + (dc / sc) ** 2 + (dh / sh) ** 2
  return i > 0 ? Math.sqrt(i) : 0
}

/** Ids whose color (any of a multi-color's colors) is within the threshold. */
export function similarColorIds(
  rows: readonly {
    id: number
    colorHex: string | null
    multiColorHexes: string | null
  }[],
  query: string,
  threshold: number,
): Set<number> | null {
  const rgb = hexToRgb(query)
  if (!rgb) return null
  const target = rgbToLab(rgb)
  const ids = new Set<number>()
  for (const row of rows) {
    const colors =
      row.colorHex !== null
        ? [row.colorHex]
        : row.multiColorHexes !== null
          ? row.multiColorHexes.split(',')
          : []
    for (const color of colors) {
      const own = hexToRgb(color)
      if (!own) return null
      if (deltaE(target, rgbToLab(own)) <= threshold) {
        ids.add(row.id)
        break
      }
    }
  }
  return ids
}

const UID_MAX_LENGTH = 64

/** Upstream `normalize_uid`; `{ error }` carries the 400 message. */
export function normalizeUid(uid: string): { uid: string } | { error: string } {
  let normalized = uid
    .replace(/[\s:_.-]+/gu, '')
    .trim()
    .toUpperCase()
  if (normalized.startsWith('0X')) normalized = normalized.slice(2)
  if (!normalized) return { error: 'A tag UID must not be empty.' }
  if (!/^[0-9A-F]+$/.test(normalized))
    return {
      error: `"${uid}" is not a valid tag UID. A UID must be hexadecimal.`,
    }
  if (normalized.length > UID_MAX_LENGTH)
    return {
      error: `A tag UID can be at most ${UID_MAX_LENGTH} hex characters.`,
    }
  if (normalized.length % 2)
    return {
      error:
        'A tag UID must contain a whole number of bytes (an even number of hex characters).',
    }
  return { uid: normalized }
}
