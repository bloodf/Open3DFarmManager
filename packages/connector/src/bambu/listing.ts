export interface BambuFile {
  name: string
  size: number
  modifiedAt: string
}

export function parseBambuListing(
  listing: string,
  extension: RegExp = /\.(3mf|gcode)$/i,
): BambuFile[] {
  const files: BambuFile[] = []
  for (const line of listing.split(/\r?\n/)) {
    const match = /^((?:[^;\s]+=[^;]*;)+) (.+)$/.exec(line)
    if (!match) continue
    const facts = new Map(
      match[1]!
        .split(';')
        .filter(Boolean)
        .map((fact) => {
          const pos = fact.indexOf('=')
          return [fact.slice(0, pos).toLowerCase(), fact.slice(pos + 1)]
        }),
    )
    const name = match[2]!
    const size = facts.get('size')
    const date = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.\d+)?$/.exec(
      facts.get('modify') ?? '',
    )
    if (
      facts.get('type')?.toLowerCase() !== 'file' ||
      !extension.test(name) ||
      /[\/\\\x00-\x1f\x7f]/.test(name) ||
      !size ||
      !/^\d+$/.test(size) ||
      !Number.isSafeInteger(Number(size)) ||
      !date
    )
      continue
    const iso = `${date[1]}-${date[2]}-${date[3]}T${date[4]}:${date[5]}:${date[6]}.000Z`
    const time = new Date(iso)
    if (!Number.isFinite(time.getTime()) || time.toISOString() !== iso) continue
    files.push({ name, size: Number(size), modifiedAt: iso })
  }
  return sortListing(files)
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]
const RECENT_LIST_WINDOW_MS = 183 * 24 * 60 * 60 * 1000

/**
 * Bambu's Unix LIST rows omit the timezone and, for recent files, the year.
 * Interpret them as UTC. An inferred date more than 183 days ahead belongs
 * to the previous year. This leaves room for timezone and clock skew.
 *
 * Simulated coverage only. Protocol observations:
 * https://github.com/sksat/bambu-rs/blob/main/docs/protocol.md#ftp-capabilities-implicit-ftps-port-990
 */
export function parseBambuUnixListing(
  listing: string,
  extension: RegExp,
  now = new Date(),
): BambuFile[] {
  const files: BambuFile[] = []
  const latestRecentDate = new Date(
    now.getTime() + RECENT_LIST_WINDOW_MS,
  ).toISOString()
  const year = now.getUTCFullYear()
  for (const line of listing.split(/\r?\n/)) {
    const match =
      /^-[rwxstST-]{9}\s+\d+\s+\S+\s+\S+\s+(\d+)\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{4}|\d{2}:\d{2}) (.+)$/.exec(
        line,
      )
    if (!match) continue
    const [
      ,
      rawSize = '',
      monthName = '',
      day = '',
      yearOrTime = '',
      name = '',
    ] = match
    const size = Number(rawSize)
    const month = MONTHS.indexOf(monthName) + 1
    if (
      month === 0 ||
      !Number.isSafeInteger(size) ||
      !extension.test(name) ||
      /[\/\\\x00-\x1f\x7f]/.test(name)
    )
      continue

    const recent = yearOrTime.includes(':')
    const date = `${String(month).padStart(2, '0')}-${day.padStart(2, '0')}T${recent ? yearOrTime : '00:00'}:00.000Z`
    let modifiedAt = `${recent ? year : yearOrTime}-${date}`
    if (recent && modifiedAt > latestRecentDate)
      modifiedAt = `${year - 1}-${date}`
    const time = new Date(modifiedAt)
    if (!Number.isFinite(time.getTime()) || time.toISOString() !== modifiedAt)
      continue
    files.push({ name, size, modifiedAt })
  }
  return sortListing(files)
}

function sortListing(files: BambuFile[]): BambuFile[] {
  return files
    .sort(
      (a, b) =>
        b.modifiedAt.localeCompare(a.modifiedAt) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, 200)
}
