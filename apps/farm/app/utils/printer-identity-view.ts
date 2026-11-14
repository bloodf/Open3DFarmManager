import {
  matchCompatibility,
  type ObservedPrinterIdentity,
} from './compatibility/match'
import { capabilityLabels } from './compatibility'

export function printerIdentityView(
  identity: ObservedPrinterIdentity | null | undefined,
) {
  const match = matchCompatibility(identity)
  return {
    model: identity?.model?.trim() || 'não identificado',
    firmware: identity?.firmware?.trim() || 'não identificado',
    compatibility: match.identified
      ? {
          href: `/compatibilidade#${match.product.id}`,
          label: match.label,
          statuses: Object.entries(match.statusLabels).map(([key, value]) => ({
            label: capabilityLabels[key as keyof typeof capabilityLabels],
            value,
          })),
        }
      : null,
  }
}
