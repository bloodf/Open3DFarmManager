/**
 * Parse Moonraker `GET /server/spoolman/spool_id` JSON.
 * Only numeric `spool_id` values are accepted (Moonraker's wire type).
 * @see https://moonraker.readthedocs.io/en/latest/external_api/spoolman/
 */
export function parseMoonrakerActiveSpoolId(body: unknown): number | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    return null
  const result = Reflect.get(body, 'result')
  if (result === null || typeof result !== 'object' || Array.isArray(result))
    return null
  const spoolId = Reflect.get(result, 'spool_id')
  if (
    typeof spoolId === 'number' &&
    Number.isSafeInteger(spoolId) &&
    spoolId > 0
  )
    return spoolId
  return null
}
