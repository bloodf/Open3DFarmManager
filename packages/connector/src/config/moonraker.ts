import { z } from 'zod'

export type MoonrakerLimits = Readonly<{
  maxMessageBytes: number
  connectTimeoutMs: number
  requestTimeoutMs: number
  staleAfterMs: number
  reconnectMinMs: number
  reconnectMaxMs: number
}>

const duration = z.number().int().min(1).max(2_147_483_647)
const Limits = z
  .strictObject({
    maxMessageBytes: z
      .number()
      .int()
      .min(256)
      .max(256 * 1024),
    connectTimeoutMs: duration,
    requestTimeoutMs: duration,
    staleAfterMs: duration,
    reconnectMinMs: duration,
    reconnectMaxMs: duration,
  })
  .refine((value) => value.reconnectMinMs <= value.reconnectMaxMs)

export function validateMoonrakerInput(input: {
  assignment: { printerKey: string; origin: string }
  allowedOrigins: readonly string[]
  limits: MoonrakerLimits
}): { printerKey: string; origin: string; limits: MoonrakerLimits } {
  const printerKey = z
    .string()
    .min(1)
    .max(128)
    .refine((key) => !/[\u0000\uD800-\uDFFF]/u.test(key))
    .parse(input.assignment.printerKey)
  const limits = Limits.parse(input.limits)
  function originOnly(value: string): string {
    if (
      !/^https?:\/\/[^/?#]+\/?$/i.test(value) ||
      /[\u0000-\u0020\u007F]/u.test(value) ||
      value.includes('@') ||
      value.includes('\\') ||
      value.trim() !== value
    )
      throw new Error('Invalid local Moonraker origin')
    const url = new URL(value)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      throw new Error('Invalid local Moonraker origin')
    return url.origin
  }
  const origin = originOnly(input.assignment.origin)
  if (!input.allowedOrigins.map(originOnly).includes(origin))
    throw new Error('Moonraker origin is not allowlisted')
  return { printerKey, origin, limits }
}
