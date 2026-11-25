/** Length of a decoded telemetry string, measured in UTF-16 code units. */
export const PRINTER_STRING_MAX_UNITS = 128

/** Free text without control characters; tab, line feed and return are kept. */
export const REFUSAL_TEXT_PATTERN = /^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]*$/

// With the Unicode flag, the range matches lone surrogate units only.
const loneSurrogate = /[\uD800-\uDFFF]/u

export function isWellFormedJsonString(value: string): boolean {
  return !loneSurrogate.test(value)
}

/** Fit printer text to the wire limit without cutting a Unicode code point. */
export function boundPrinterString(
  value: string,
  maxUnits = PRINTER_STRING_MAX_UNITS,
): string {
  const limit = Math.min(maxUnits, PRINTER_STRING_MAX_UNITS)
  let end = 0
  for (const point of value) {
    if (end + point.length > limit) break
    end += point.length
  }
  return value.slice(0, end).replace(/[\uD800-\uDFFF]/gu, '\uFFFD')
}
