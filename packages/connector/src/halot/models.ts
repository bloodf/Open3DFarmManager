// The HALOT catalog models and what supports each. Sources (H1..H9) are listed
// in docs/protocols/halot.md; gaps in docs/fullfarmmanager/evidence/halot.md.

/**
 * `internalCode` is the name Creality's HALOT BOX 4.7.0.10 gives the model in
 * its printer list. The printer never sends it: it identifies nothing here.
 * `client`: `third-party` means a public client was written for this model;
 * `vendor-only` means only HALOT BOX is known to reach it.
 */
export const HALOT_MODELS = {
  'HALOT-X1 Max': { internalCode: 'R012', client: 'vendor-only' },
  'HALOT-X1': { internalCode: 'R009', client: 'vendor-only' },
  'HALOT-MAGE S': { internalCode: 'R006', client: 'third-party' },
  'HALOT-MAGE PRO': { internalCode: 'CL-103', client: 'third-party' },
} as const satisfies Record<
  string,
  { internalCode: string; client: 'third-party' | 'vendor-only' }
>

export type HalotModel = keyof typeof HALOT_MODELS

export const HALOT_MODEL_NAMES = Object.keys(HALOT_MODELS) as [
  HalotModel,
  ...HalotModel[],
]
