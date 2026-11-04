import { flagEnabled } from '@open3dfarmmanager/shared'

export function useFlag(name: 'farmView'): boolean {
  return flagEnabled(useRuntimeConfig().public.flags[name])
}
