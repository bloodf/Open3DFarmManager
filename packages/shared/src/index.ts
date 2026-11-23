import manifest from '../../../package.json' with { type: 'json' }

export function flagEnabled(value: unknown): boolean {
  return value === true || value === 'true' || value === '1' || value === 1
}

export const projectVersion = manifest.version

export { createLogger, redact } from './log.ts'
export type { Logger, LogLevel } from './log.ts'

export { checkCompatibility } from './print-file/compatibility.ts'
