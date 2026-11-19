export const MAX_FILE_SIZE = 512 * 1024 * 1024
export const CHUNK_SIZE = 16 * 1024
export type Offer = {
  config?: true
  type: 'offer'
  transfer_id: string
  name: string
  size: number
  sha256: string
  printer_key: string
}
export function parseOffer(value: unknown): Offer {
  if (!value || typeof value !== 'object') throw new Error('invalid_offer')
  const v = value as Record<string, unknown>
  if (
    Object.keys(v).sort().join(',') !==
      (v.config === true
        ? 'config,name,printer_key,sha256,size,transfer_id,type'
        : 'name,printer_key,sha256,size,transfer_id,type') ||
    v.type !== 'offer' ||
    typeof v.transfer_id !== 'string' ||
    !/^[a-zA-Z0-9-]{1,64}$/.test(v.transfer_id) ||
    typeof v.printer_key !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(v.printer_key) ||
    typeof v.name !== 'string' ||
    !(
      v.config === true
        ? /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,190}\.cfg$/
        : /^[a-zA-Z0-9 _.-]{1,200}\.(gcode|3mf)$/i
    ).test(v.name) ||
    (v.config !== true && v.name.includes('..')) ||
    typeof v.size !== 'number' ||
    !Number.isSafeInteger(v.size) ||
    v.size < (v.config === true ? 0 : 1) ||
    v.size > (v.config === true ? 1024 * 1024 : MAX_FILE_SIZE) ||
    typeof v.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(v.sha256)
  )
    throw new Error('invalid_offer')
  return v as Offer
}
