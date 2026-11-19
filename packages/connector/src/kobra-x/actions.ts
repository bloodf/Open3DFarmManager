import { record } from './discovery.ts'
import {
  runGated,
  type KobraXCall,
  type KobraXControlContext,
} from './context.ts'
import { refusedLocally, type KobraXOutcome } from './requests.ts'

export type KobraXSpeedLevel = 'silent' | 'standard' | 'sport' | 'ludicrous'
// Unverified wire values; see docs/compatibility/kobra-x-lan.md "Unverified items".
const SPEED_MODE: Record<KobraXSpeedLevel, number> = {
  silent: 1,
  standard: 2,
  sport: 3,
  ludicrous: 4,
}
/** Local safety ceilings. The clean-room spec documents no printer limits. */
export const MAX_NOZZLE_CELSIUS = 300
export const MAX_BED_CELSIUS = 110
const MAX_SKIPPED_OBJECTS = 16
const MAX_OBJECT_ID = 63

const refuse = (reason: string) =>
  Promise.resolve<KobraXOutcome<never>>(refusedLocally(reason))

export function createKobraXActions(context: KobraXControlContext) {
  const taskId = () => context.facts.get().taskId ?? '-1'
  const lifecycle = (
    action: 'pause' | 'resume' | 'stop',
    expected: string,
    call: KobraXCall,
  ) =>
    runGated(context, { action }, call, {
      type: 'print',
      action,
      data: { taskid: taskId() },
      effect: (report) => report.state === expected,
    })

  return {
    pause: (call: KobraXCall) => lifecycle('pause', 'paused', call),
    resume: (call: KobraXCall) => lifecycle('resume', 'printing', call),
    stop: (call: KobraXCall) => lifecycle('stop', 'stoped', call),

    setLight(on: boolean, call: KobraXCall) {
      const status = on ? 1 : 0
      return runGated(context, { action: 'light' }, call, {
        type: 'light',
        action: 'control',
        data: { type: 3, status, brightness: on ? 100 : 0 },
        effect: (report) => report.data.status === status,
      })
    },

    setFan(percent: number, call: KobraXCall) {
      if (!Number.isInteger(percent) || percent < 0 || percent > 100)
        return refuse('invalid-value')
      const printing = context.state() !== 'idle'
      return runGated(
        context,
        { action: 'fan' },
        call,
        printing
          ? {
              // During a job the change applies through `print/update`.
              type: 'print',
              action: 'update',
              data: { taskid: taskId(), settings: { fan_speed_pct: percent } },
              effect: (report) =>
                record(report.data.settings).fan_speed_pct === percent,
            }
          : {
              type: 'fan',
              action: 'setSpeed',
              data: { fan_speed_pct: percent },
              effect: (report) => report.data.fan_speed_pct === percent,
            },
      )
    },

    setSpeed(level: KobraXSpeedLevel, call: KobraXCall) {
      const mode = SPEED_MODE[level]
      if (mode === undefined) return refuse('invalid-value')
      return runGated(context, { action: 'speed' }, call, {
        type: 'print',
        action: 'update',
        data: { taskid: taskId(), settings: { print_speed_mode: mode } },
        effect: (report) =>
          record(report.data.settings).print_speed_mode === mode,
      })
    },

    /** Home all axes. Answers only when finished, which takes tens of seconds. */
    home(call: KobraXCall) {
      return runGated(context, { action: 'home' }, call, {
        type: 'axis',
        action: 'move',
        data: { axis: 5, move_type: 2 },
        resultTimeoutMs: context.motionResultTimeoutMs ?? 60_000,
      })
    },

    jog(axis: 'x' | 'y' | 'z', direction: 'plus' | 'minus', call: KobraXCall) {
      const wire = { x: 1, y: 2, z: 3 }[axis]
      if (wire === undefined || (direction !== 'plus' && direction !== 'minus'))
        return refuse('invalid-value')
      return runGated(context, { action: 'jog' }, call, {
        type: 'axis',
        action: 'move',
        data: { axis: wire, move_type: direction === 'plus' ? 1 : 0 },
        resultTimeoutMs: context.motionResultTimeoutMs ?? 60_000,
      })
    },

    /** Idle heating only: the state gate refuses it during a job. */
    setTemperature(
      heater: 'extruder' | 'bed',
      targetC: number,
      call: KobraXCall,
    ) {
      const nozzle = heater === 'extruder'
      if (
        (!nozzle && heater !== 'bed') ||
        !Number.isInteger(targetC) ||
        targetC < 0 ||
        targetC > (nozzle ? MAX_NOZZLE_CELSIUS : MAX_BED_CELSIUS)
      )
        return refuse('invalid-value')
      const field = nozzle ? 'target_nozzle_temp' : 'target_hotbed_temp'
      return runGated(context, { action: 'heat' }, call, {
        type: 'tempature',
        action: 'set',
        data: { type: 2, [field]: targetC },
        effect: (report) => report.data[field] === targetC,
      })
    },

    skipObjects(objects: readonly number[], call: KobraXCall) {
      const unique = [...new Set(objects)]
      if (
        !unique.length ||
        unique.length > MAX_SKIPPED_OBJECTS ||
        unique.some(
          (id) => !Number.isInteger(id) || id < 0 || id > MAX_OBJECT_ID,
        )
      )
        return refuse('invalid-value')
      const merged = [
        ...new Set([...context.facts.get().skippedObjects, ...unique]),
      ]
      return runGated(context, { action: 'skip' }, call, {
        type: 'skip',
        action: 'set',
        data: { skipped_objects: merged },
        effect: (report) =>
          Array.isArray(report.data.skipped_objects) &&
          unique.every((id) =>
            (report.data.skipped_objects as unknown[]).includes(id),
          ),
      })
    },
  }
}
