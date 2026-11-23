export type MotionFactorEdited = { speed: boolean; flow: boolean }

/** Keep each input aligned with printer state until that field is edited. */
export function syncMotionFactors(
  edited: MotionFactorEdited,
  speedPct: number | undefined,
  flowPct: number | undefined,
  current: { speed: string; flow: string } = { speed: '', flow: '' },
) {
  return {
    speed: edited.speed ? current.speed : String(speedPct ?? 100),
    flow: edited.flow ? current.flow : String(flowPct ?? 100),
  }
}
