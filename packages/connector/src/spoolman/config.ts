import { z } from 'zod'

/** Trusted private local configuration only. No browser/cloud supplied origins. */
export const SpoolmanConfig = z.strictObject({
  origin: z
    .string()
    .max(2048)
    .refine((value) => {
      try {
        const url = new URL(value)
        return (
          ['http:', 'https:'].includes(url.protocol) &&
          value === url.origin &&
          !url.username &&
          !url.password
        )
      } catch {
        return false
      }
    }, 'Canonical Spoolman origin required'),
  farmId: z.string().uuid(),
  serviceId: z.string().uuid(),
  limit: z.number().int().min(1).max(200).default(200),
})
export type SpoolmanConfig = z.infer<typeof SpoolmanConfig>
