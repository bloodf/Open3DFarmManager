import { IntegrationLimits } from './integration-auth-limits.ts'

export const defaultIntegrationRateLimits = { read: 120, write: 30 } as const

export interface IntegrationRateLimitConfig {
  read?: unknown
  write?: unknown
}

function configuredLimit(value: unknown, fallback: number) {
  if (value === undefined || value === null || value === '') return fallback
  const limit = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000_000)
    throw new Error(
      'Integration rate limits must be integers from 1 to 1000000.',
    )
  return limit
}

export function parseIntegrationRateLimitConfig(
  config: IntegrationRateLimitConfig = {},
) {
  return {
    read: configuredLimit(config.read, defaultIntegrationRateLimits.read),
    write: configuredLimit(config.write, defaultIntegrationRateLimits.write),
  }
}

export function takeIntegrationRequestLimit(
  buckets: IntegrationLimits,
  appId: string,
  method: string,
  config: IntegrationRateLimitConfig = {},
) {
  const limits = parseIntegrationRateLimitConfig(config)
  const isRead = method === 'GET' || method === 'HEAD'
  const rate = buckets.take(
    `${isRead ? 'read' : 'write'}:${appId}`,
    isRead ? limits.read : limits.write,
  )
  return {
    ...rate,
    headers: {
      'ratelimit-limit': String(rate.limit),
      'ratelimit-remaining': String(rate.remaining),
      'ratelimit-reset': String(rate.reset),
      ...(!rate.allowed ? { 'retry-after': String(rate.retry) } : {}),
    },
  }
}
