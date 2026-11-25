import type { ExtendedControlAction } from '../../../farm-protocol/src/control-actions.ts'
import type { FlashforgeBinding } from './config.ts'

export type FlashforgeModel = FlashforgeBinding['expect']['model']

/** One exact model and firmware pair. */
export type FlashforgeQualification = Readonly<{
  model: FlashforgeModel
  firmware: string
}>

/**
 * Pairs whose writes passed a supervised run on hardware. Empty: no Flashforge
 * write is offered or sent. Add a pair only with that run recorded in
 * docs/fullfarmmanager/evidence/qidi-flashforge.md.
 */
export const FLASHFORGE_QUALIFIED_WRITES: readonly FlashforgeQualification[] =
  Object.freeze([])

const SHARED = Object.freeze([
  'pause',
  'resume',
  'cancel',
  'set_temperature',
  'set_fan',
] as const satisfies readonly ExtendedControlAction[])

/**
 * Signed actions with a documented wire command and a `/detail` readback, per
 * model. The AD5X material station adds `ms_cmd` load and `msConfig_cmd`; the
 * 5M series adds `streamCtrl_cmd`.
 */
export const FLASHFORGE_CONTROLS: Readonly<
  Record<FlashforgeModel, readonly ExtendedControlAction[]>
> = Object.freeze({
  'Adventurer 5M': Object.freeze([...SHARED, 'set_camera_stream' as const]),
  'Adventurer 5M Pro': Object.freeze([...SHARED, 'set_camera_stream' as const]),
  AD5X: Object.freeze([
    ...SHARED,
    'load_filament' as const,
    'set_filament_slot' as const,
  ]),
})

export function flashforgeWritesQualified(
  model: string,
  firmware: string,
  qualified: readonly FlashforgeQualification[] = FLASHFORGE_QUALIFIED_WRITES,
): boolean {
  return qualified.some(
    (pair) => pair.model === model && pair.firmware === firmware,
  )
}
