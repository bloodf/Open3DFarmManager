// SPDX-License-Identifier: MIT
export interface GoProbe {
  ok: boolean
  reason: string | undefined
  minGoVersion: string
  foundGoVersion: string | undefined
  message: string
}
export declare function probeGoToolchain(options?: {
  env?: NodeJS.ProcessEnv
  goBin?: string
  goModPath?: string
  minGoVersion?: string
}): GoProbe
