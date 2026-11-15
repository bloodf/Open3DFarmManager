/** Maps the version carried by an Anycubic LAN report without initiating an update. */
export function mapAnycubicFirmware(
  report: unknown,
): { current: string } | undefined {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return
  const envelope = report as Record<string, unknown>
  const data = 'data' in envelope ? envelope.data : envelope
  if (!data || typeof data !== 'object' || Array.isArray(data)) return
  const version = (data as Record<string, unknown>).version
  if (typeof version !== 'string' || !version.trim() || version.length > 64)
    return
  return { current: version }
}
