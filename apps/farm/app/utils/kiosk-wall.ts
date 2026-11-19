/** Seconds after which a reading, or the poll that fetched it, is stale. */
export const KIOSK_STALE_SECONDS = 30
export const KIOSK_POLL_MS = 5_000
export const KIOSK_PAGE_MS = 10_000

// Card footprint in rem. The page scales rem with the viewport width, so the
// same count of cards fits at 1080p and at 4K.
const CARD_WIDTH_REM = 15
const CARD_HEIGHT_REM = 11
const HEADER_REM = 5

/** Root font size in px: 16 px floor, grows with the width (20 px at 1080p, 40 px at 4K). */
export function kioskRemPx(width: number) {
  return Math.max(16, width * 0.0104)
}

/** How many cards fit on one screen. Never less than one. */
export function kioskCapacity(width: number, height: number) {
  const rem = kioskRemPx(width)
  const columns = Math.max(1, Math.floor(width / (CARD_WIDTH_REM * rem)))
  const rows = Math.max(
    1,
    Math.floor((height - HEADER_REM * rem) / (CARD_HEIGHT_REM * rem)),
  )
  return columns * rows
}

export function kioskPageCount(total: number, perPage: number) {
  return Math.max(1, Math.ceil(total / Math.max(1, perPage)))
}

/** Keeps a page index valid when printers come and go between polls. */
export function clampKioskPage(page: number, total: number, perPage: number) {
  const last = kioskPageCount(total, perPage) - 1
  return Number.isInteger(page) ? Math.min(Math.max(page, 0), last) : 0
}

export function kioskPageItems<T>(
  items: readonly T[],
  page: number,
  perPage: number,
) {
  const size = Math.max(1, perPage)
  const start = clampKioskPage(page, items.length, size) * size
  return items.slice(start, start + size)
}
