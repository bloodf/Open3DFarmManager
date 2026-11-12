export function flagEnabled(value: unknown): boolean {
  return value === true || value === 'true' || value === '1' || value === 1
}

export const projectVersion = '0.0.1'

export { createLogger, redact } from './log.ts'
export type { Logger, LogLevel } from './log.ts'
