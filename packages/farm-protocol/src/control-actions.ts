import { z } from 'zod'

/** Lifecycle actions; the dashboard labels and state machine cover exactly these. */
export const ControlAction = z.enum(['pause', 'resume', 'cancel'])
export type ControlAction = z.infer<typeof ControlAction>
/** Every action a signed 'printer-control' command may carry. */
export const ExtendedControlAction = z.enum([
  ...ControlAction.options,
  'emergency_stop',
  'set_temperature',
  'set_fan',
  'home',
  'set_light',
  'set_speed',
  'start_print',
  'firmware_restart',
])
export type ExtendedControlAction = z.infer<typeof ExtendedControlAction>
export const MOONRAKER_CONTROLS: readonly ControlAction[] = Object.freeze([
  'pause',
  'resume',
  'cancel',
])
export function controlsForBackend(backend: string): readonly ControlAction[] {
  return backend === 'moonraker' ? MOONRAKER_CONTROLS : []
}
export function controlRoleAllowed(role: string): boolean {
  return ['owner', 'admin', 'operator'].includes(role)
}
export function controlSourceState(
  action: ExtendedControlAction,
  state: string,
): boolean {
  if (action === 'emergency_stop') return true
  if (action === 'firmware_restart')
    return state === 'error' || state === 'idle'
  if (!['pause', 'resume', 'cancel'].includes(action))
    return state !== 'unknown' && state !== 'error'
  return action === 'resume'
    ? state === 'paused'
    : action === 'cancel'
      ? state === 'printing' || state === 'paused'
      : state === 'printing'
}
export function controlTargetState(
  action: ExtendedControlAction,
): 'paused' | 'printing' | 'cancelled' {
  return action === 'pause'
    ? 'paused'
    : action === 'resume'
      ? 'printing'
      : 'cancelled'
}

export const ControlArguments = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.enum([
      'pause',
      'resume',
      'cancel',
      'emergency_stop',
      'firmware_restart',
    ]),
    args: z.strictObject({}),
  }),
  z.strictObject({
    action: z.literal('set_temperature'),
    args: z.strictObject({
      heater: z.enum(['extruder', 'bed', 'chamber']),
      target_c: z.number().int().nonnegative(),
    }),
  }),
  z.strictObject({
    action: z.literal('set_fan'),
    args: z.strictObject({
      fan: z.enum(['part', 'aux', 'chamber']),
      percent: z.number().int().min(0).max(100),
    }),
  }),
  z.strictObject({
    action: z.literal('home'),
    args: z.strictObject({
      axes: z
        .array(z.enum(['x', 'y', 'z']))
        .min(1)
        .max(3)
        .refine((v) => new Set(v).size === v.length),
    }),
  }),
  z.strictObject({
    action: z.literal('set_light'),
    args: z.strictObject({ on: z.boolean() }),
  }),
  z.strictObject({
    action: z.literal('set_speed'),
    args: z.strictObject({
      level: z.enum(['silent', 'standard', 'sport', 'ludicrous']),
    }),
  }),
  z.strictObject({
    action: z.literal('start_print'),
    args: z.strictObject({
      file: z
        .string()
        .min(1)
        .max(255)
        .refine((v) => !/[\\/\x00-\x1f\x7f]/.test(v) && !v.includes('..')),
    }),
  }),
])
export type ControlArgs = z.infer<typeof ControlArguments>['args']
