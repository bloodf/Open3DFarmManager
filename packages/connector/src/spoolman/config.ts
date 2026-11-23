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
  /** Private file written by config-v1 holding optional Spoolman credentials. */
  credentialFile: z.string().min(1).max(4096).optional(),
  /** Manual spool-to-tool assignments; defaults to the Connector data directory. */
  assignmentsFile: z.string().min(1).max(4096).optional(),
})
export type SpoolmanConfig = z.infer<typeof SpoolmanConfig>
