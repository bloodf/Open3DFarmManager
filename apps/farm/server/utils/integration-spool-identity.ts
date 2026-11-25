export function spoolIdentity(
  serviceId: string | null | undefined,
  spoolId: number | null | undefined,
) {
  if (!serviceId || spoolId == null) return undefined
  const id = serviceId.toLowerCase()
  return { serviceId: id, spoolKey: `${id}:${spoolId}` }
}

export function publishSpoolBinding<T extends Record<string, unknown>>({
  serviceId,
  serviceSpoolId,
  ...row
}: T) {
  if (typeof serviceId !== 'string' || typeof serviceSpoolId !== 'number')
    return row
  return { ...row, ...spoolIdentity(serviceId, serviceSpoolId), serviceSpoolId }
}
