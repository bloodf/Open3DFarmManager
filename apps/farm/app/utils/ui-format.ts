const locale = 'pt-BR'
const dateTime = new Intl.DateTimeFormat(locale, {
  dateStyle: 'short',
  timeStyle: 'medium',
  timeZone: 'America/Sao_Paulo',
})
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
): string | undefined {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? dateTime.format(date) : undefined
}

export function formatDuration(seconds: number): string | undefined {
  if (!Number.isFinite(seconds) || seconds < 0) return undefined
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const remainder = minute.format(minutes % 60)
  return hours ? `${hour.format(hours)} ${remainder}` : remainder
}

export function formatTemperature(celsius: number): string | undefined {
  return Number.isFinite(celsius) ? temperature.format(celsius) : undefined
}

export function formatWeight(grams: number): string | undefined {
  return Number.isFinite(grams) && grams >= 0 ? weight.format(grams) : undefined
}

export function formatPercentage(points: number): string | undefined {
  return Number.isFinite(points) ? percent.format(points / 100) : undefined
}
