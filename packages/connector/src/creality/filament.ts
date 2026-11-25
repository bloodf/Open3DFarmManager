/**
 * CFS (Creality Filament System) load and unload. Wire facts only; not run on
 * a printer. External spool holders are not covered.
 *
 * - `{"method":"set","params":{"feedInOrOut":{"boxId","materialId","isFeed"}}}`
 *   (1 = feed, 0 = retract); `feedState` 0, 3 (feed finished), 14 (retract
 *   finished) and 100 are the idle values; a slot with an empty `type` is not
 *   fed. Maker device UI: CrealityOfficial/CrealityPrint@
 *   6262848e302b8c0d593f2b341cd01310aa2f58a1
 *   resources/web/deviceMgr/assets/D-MKTaRJ.js (`feedInOrOutMaterial`,
 *   `feedMaterial`, `retractMaterial`, `feedstate`). A box with `type` 0 is a
 *   CFS unit.
 * - `{"method":"get","params":{"boxsInfo":1}}` and `selected` marking the
 *   active slot: 3dg1luk43/ha_creality_ws@
 *   58c00818e8303a0d636bd05929cad215aed9ccb3 ws_client.py and
 *   docs/internal/reference/02-entities-camera-config.md.
 */
import { CrealityRefused, type CrealitySetFrame } from './commands.ts'

export const CREALITY_BOXES_REQUEST = {
  method: 'get',
  params: { boxsInfo: 1 },
} as const
export const CREALITY_FEED_IDLE_STATES: readonly number[] = [0, 3, 14, 100]
export const CREALITY_FEED_DONE = 3
export const CREALITY_RETRACT_DONE = 14
/**
 * F022 runs a different feed state machine and F039 (several nozzles) a
 * different slot-to-nozzle model in the maker UI; neither is mapped here.
 */
const UNMAPPED_MODELS = ['F022', 'F039']

export type CrealityCfsSlot = Readonly<{
  boxId: number
  materialId: number
  loadable: boolean
  selected: boolean
}>

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const id = (value: unknown, max: number): value is number =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= max

/**
 * CFS slots of a `boxsInfo` report keyed by the shared `tray` number: four per
 * unit, units in ascending box id. A malformed report yields nothing.
 */
export function readCrealityCfsSlots(
  boxsInfo: unknown,
): ReadonlyMap<number, CrealityCfsSlot> | undefined {
  if (!record(boxsInfo) || !Array.isArray(boxsInfo.materialBoxs)) return
  const units: Array<{ boxId: number; materials: unknown[] }> = []
  for (const box of boxsInfo.materialBoxs) {
    if (!record(box)) return
    if (box.type !== 0) continue
    if (!id(box.id, 4) || !Array.isArray(box.materials)) return
    units.push({ boxId: box.id, materials: box.materials })
  }
  if (
    units.length > 4 ||
    new Set(units.map((u) => u.boxId)).size !== units.length
  )
    return
  const slots = new Map<number, CrealityCfsSlot>()
  units.sort((a, b) => a.boxId - b.boxId)
  for (const [index, unit] of units.entries())
    for (const material of unit.materials) {
      if (!record(material) || !id(material.id, 3)) return
      const tray = index * 4 + material.id
      if (slots.has(tray)) return
      slots.set(tray, {
        boxId: unit.boxId,
        materialId: material.id,
        loadable: typeof material.type === 'string' && material.type !== '',
        selected: material.selected === 1,
      })
    }
  return slots
}

/** Refuses from what is known before the slots are read. */
export function checkCrealityFeed(input: {
  action: string
  args: Record<string, unknown>
  model: unknown
  feedState: unknown
}): void {
  const { action, args } = input
  if (action !== 'load_filament' && action !== 'unload_filament')
    throw new CrealityRefused(
      'unsupported-action',
      `Unsupported Creality filament action '${action}'`,
    )
  const allowed = action === 'load_filament' ? ['tray'] : []
  if (
    Object.keys(args).some((key) => !allowed.includes(key)) ||
    (action === 'load_filament' && !id(args.tray, 15))
  )
    throw new CrealityRefused(
      'invalid-command',
      'Creality CFS load needs a tray from 0 to 15',
    )
  if (UNMAPPED_MODELS.includes(input.model as string))
    throw new CrealityRefused(
      'unsupported-action',
      'Creality CFS feed is not mapped for this model',
    )
  if (!CREALITY_FEED_IDLE_STATES.includes(input.feedState as number))
    throw new CrealityRefused(
      'state',
      'Creality feeder is busy or reports no feed state',
    )
}

/**
 * The single feed frame, from a slot report read just before sending. Without
 * that report no filament action can be built.
 */
export function buildCrealityFilamentCommand(
  action: string,
  args: Record<string, unknown> = {},
  slots?: ReadonlyMap<number, CrealityCfsSlot>,
): CrealitySetFrame {
  if (!slots)
    throw new CrealityRefused(
      'unsupported-action',
      `Unsupported Creality filament action '${action}' without a CFS slot report`,
    )
  checkCrealityFeed({ action, args, model: undefined, feedState: 0 })
  let slot: CrealityCfsSlot | undefined
  if (action === 'load_filament') {
    slot = slots.get(args.tray as number)
    if (!slot?.loadable)
      throw new CrealityRefused(
        'state',
        'Creality CFS slot is absent or has no filament type',
      )
  } else {
    const active = [...slots.values()].filter((item) => item.selected)
    if (active.length !== 1)
      throw new CrealityRefused(
        'state',
        'Creality CFS reports no single active slot',
      )
    slot = active[0]!
  }
  return {
    method: 'set',
    params: {
      feedInOrOut: {
        boxId: slot.boxId,
        materialId: slot.materialId,
        isFeed: action === 'load_filament' ? 1 : 0,
      },
    },
  }
}
