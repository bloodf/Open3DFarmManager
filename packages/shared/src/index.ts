export function flagEnabled(value: unknown): boolean {
  return value === true || value === 'true' || value === '1' || value === 1
}

export const projectVersion = '0.0.1'
