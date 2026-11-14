export const MAX_UPLOAD_BYTES = 512 * 1024 * 1024
export function validateUpload(file: {
  name: string
  size: number
}): string | undefined {
  if (!/\.(gcode|3mf)$/i.test(file.name))
    return 'Selecione um arquivo .gcode ou .3mf.'
  if (
    !Number.isSafeInteger(file.size) ||
    file.size <= 0 ||
    file.size > MAX_UPLOAD_BYTES
  )
    return 'O arquivo deve ter entre 1 byte e 512 MiB.'
  return undefined
}
