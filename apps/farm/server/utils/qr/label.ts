import { renderSVG } from 'uqr'

/** Four quiet-zone modules are required for reliable scanning. */
export function labelQr(url: string): string {
  return renderSVG(url, { border: 4, ecc: 'M' })
}
