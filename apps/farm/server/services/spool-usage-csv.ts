/** One CSV cell; text that a spreadsheet could read as a formula is neutralised. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  let text = typeof value === 'string' ? value : String(value)
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/** RFC 4180 CSV with a header row; columns come from `columns`. */
export function toCsv(
  columns: readonly string[],
  rows: readonly Record<string, unknown>[],
): string {
  const lines = [columns.map(csvCell).join(',')]
  for (const row of rows)
    lines.push(columns.map((column) => csvCell(row[column])).join(','))
  return lines.join('\r\n') + '\r\n'
}
