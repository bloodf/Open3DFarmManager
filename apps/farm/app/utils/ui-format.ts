const locale = 'pt-BR'
const dateTime = new Intl.DateTimeFormat(locale, {
  dateStyle: 'short',
  timeStyle: 'medium',
  timeZone: 'America/Sao_Paulo',
})
const dateTimeUtc = new Intl.DateTimeFormat(locale, {
  dateStyle: 'short',
  timeStyle: 'medium',
  timeZone: 'UTC',
})
const dateTimeShort = new Intl.DateTimeFormat(locale, {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'America/Sao_Paulo',
})
const dateTimeShortUtc = new Intl.DateTimeFormat(locale, {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'UTC',
})
const dates = {
  local: dateTime,
  utc: dateTimeUtc,
  short: dateTimeShort,
  'short-utc': dateTimeShortUtc,
}
const hour = new Intl.NumberFormat(locale, { style: 'unit', unit: 'hour' })
const minute = new Intl.NumberFormat(locale, { style: 'unit', unit: 'minute' })
const temperature = new Intl.NumberFormat(locale, {
  style: 'unit',
  unit: 'celsius',
  maximumFractionDigits: 1,
})
const weight = new Intl.NumberFormat(locale, {
  style: 'unit',
  unit: 'gram',
  maximumFractionDigits: 1,
})
const percent = new Intl.NumberFormat(locale, {
  style: 'percent',
  maximumFractionDigits: 1,
})

export function formatDateTime(
  value: Date | number | string,
  style: keyof typeof dates = 'local',
): string | undefined {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? dates[style].format(date) : undefined
}

export function formatDuration(
  seconds: number | undefined,
  precision: 'minute' | 'second' | 'hour-minute' = 'minute',
): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0)
    return undefined
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const remainder = minute.format(minutes % 60)
  if (precision === 'second')
    return `${hour.format(hours)} ${remainder} ${formatNumber(Math.floor(seconds) % 60)} s`
  return hours || precision === 'hour-minute'
    ? `${hour.format(hours)} ${remainder}`
    : remainder
}

export function formatTemperature(
  celsius: number | undefined,
): string | undefined {
  return celsius !== undefined && Number.isFinite(celsius)
    ? temperature.format(celsius)
    : undefined
}

export function formatWeight(
  grams: number | null | undefined,
): string | undefined {
  return grams != null && Number.isFinite(grams) && grams >= 0
    ? weight.format(grams)
    : undefined
}

export function formatPercentage(points: number): string | undefined {
  return Number.isFinite(points) ? percent.format(points / 100) : undefined
}

export function formatNumber(
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  return value.toLocaleString(locale, options)
}

const time = new Intl.DateTimeFormat(locale, {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'America/Sao_Paulo',
})
export function formatTime(value: Date): string {
  return time.format(value)
}
