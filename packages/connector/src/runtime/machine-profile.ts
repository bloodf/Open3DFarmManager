import type { MachineProfile } from '@open3dfarmmanager/farm-protocol'

function label(value: unknown) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length && trimmed.length <= 64 ? trimmed : undefined
}

/** Model-only profile for adapters whose report names the model (Creality, Kobra X). */
export function reportedModelProfile(
  value: unknown,
): MachineProfile | undefined {
  const model = label(value)
  return model ? { model } : undefined
}
