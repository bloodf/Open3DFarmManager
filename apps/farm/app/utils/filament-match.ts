// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Whether the filament a job asks for is what a printer slot holds, with the
 * sentence that says so. The result is always text: colour and the drawn reel
 * are only support. Nothing is guessed: a missing material or colour is
 * reported as such, never assumed equal or different.
 */
export type FilamentRequirement = {
  type?: string | undefined
  /** `#RRGGBB` as the slicer wrote it. */
  colour?: string | undefined
}

export type FilamentSlot = {
  materialType?: string | undefined
  /** `RRGGBBAA`, as the Connector reports it. */
  colorHex?: string | undefined
}

export type MatchedSlot = {
  /** The slot's identity, for example "Slot 2". */
  label: string
  materialType?: string | undefined
  /** `RRGGBBAA`, as the Connector reports it. */
  colorHex?: string | undefined
  remainingPercent?: number | null | undefined
  spoolmanRemainingWeight?: number | null | undefined
  spoolmanInitialWeight?: number | null | undefined
}

export type FilamentMatchKind =
  | 'match'
  | 'colour-differs'
  | 'colour-unknown'
  | 'material-differs'
  | 'material-unknown'
  | 'no-slot'

export type FilamentMatchResult = {
  kind: FilamentMatchKind
  tone: 'ok' | 'warn' | 'unknown'
  text: string
}

const HEX6 = /^#?([0-9a-f]{6})$/i
const HEX8 = /^([0-9a-f]{6})[0-9a-f]{2}$/i

/** Six lower-case hex digits, or undefined when the value is not a colour. */
export function normalizeColour(value: string | undefined): string | undefined {
  if (!value) return undefined
  const six = HEX6.exec(value) ?? HEX8.exec(value)
  return six ? six[1]!.toLowerCase() : undefined
}

/** `#rrggbb` ready to paint from a Connector `RRGGBBAA`, else undefined. */
export function slotPaint(colorHex: string | undefined): string | undefined {
  const six = normalizeColour(colorHex)
  return six ? `#${six}` : undefined
}

export function matchFilament(
  required: FilamentRequirement,
  slot: FilamentSlot | null | undefined,
): FilamentMatchResult {
  if (!slot)
    return {
      kind: 'no-slot',
      tone: 'unknown',
      text: 'Nenhum slot escolhido para este filamento.',
    }
  const wantType = required.type?.trim().toLowerCase()
  const haveType = slot.materialType?.trim().toLowerCase()
  if (!wantType || !haveType)
    return {
      kind: 'material-unknown',
      tone: 'unknown',
      text: !haveType
        ? 'O slot não informa o material: não dá para conferir.'
        : 'O arquivo não informa o material: não dá para conferir.',
    }
  if (wantType !== haveType)
    return {
      kind: 'material-differs',
      tone: 'warn',
      text: `Material diferente: o arquivo pede ${required.type}, o slot tem ${slot.materialType}.`,
    }
  const wantColour = normalizeColour(required.colour)
  const haveColour = normalizeColour(slot.colorHex)
  if (!wantColour || !haveColour)
    return {
      kind: 'colour-unknown',
      tone: 'unknown',
      text: 'Material igual. A cor não foi informada nos dois lados: confira a cor.',
    }
  if (wantColour !== haveColour)
    return {
      kind: 'colour-differs',
      tone: 'warn',
      text: 'Material igual, cor diferente.',
    }
  return { kind: 'match', tone: 'ok', text: 'Combina: material e cor iguais.' }
}
