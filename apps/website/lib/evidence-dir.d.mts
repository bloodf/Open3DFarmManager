export function resolveReal(target: string, depth?: number): Promise<string>
export function assertOutsideRepo(dir: string, repoRoot: string): Promise<void>
export function prepareEvidenceDir(options: {
  override?: string
  tmpBase: string
  repoRoot: string
}): Promise<string>
