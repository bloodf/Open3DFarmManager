import { z } from 'zod'
import type { ExtendedControlAction } from '../../../farm-protocol/src/control-actions.ts'

/**
 * Independent wire contract from NatHacks/Kobralink at
 * 5a5e5d9b1e3b9ad4f0760672cf7dc4bb8c85f5e1.
 * apps/api/src/core/core.controller.ts: temperature, fan, light, speed, axis,
 * printer-files/print; packages/shared/src/{control,files}.ts: payload bounds.
 * apps/api/src/bridge/printer-bridge.ts implements these via KobraMqttClient.
 * No emergency stop or firmware restart endpoint exists in this controller.
 */
export const KOBRALINK_CONTROLS: readonly ExtendedControlAction[] =
  Object.freeze([
    'pause',
    'resume',
    'cancel',
    'set_temperature',
    'set_fan',
    'set_light',
    'set_speed',
    'home',
    'start_print',
  ])
export const KobraLinkExtendedCommand = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('set_temperature'),
    args: z.union([
      z.strictObject({
        heater: z.literal('extruder'),
        target_c: z.number().int().min(0).max(320),
      }),
      z.strictObject({
        heater: z.literal('bed'),
        target_c: z.number().int().min(0).max(120),
      }),
    ]),
  }),
  z.strictObject({
    action: z.literal('set_fan'),
    args: z.strictObject({
      fan: z.literal('part'),
      percent: z.number().int().min(0).max(100),
    }),
  }),
  z.strictObject({
    action: z.literal('set_light'),
    args: z.strictObject({ on: z.boolean() }),
  }),
  z.strictObject({
    action: z.literal('set_speed'),
    args: z.strictObject({ level: z.enum(['silent', 'standard', 'sport']) }),
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
export type KobraLinkExtendedCommand = z.infer<typeof KobraLinkExtendedCommand>

export function kobraLinkRequests(
  command: KobraLinkExtendedCommand,
): { path: string; body: unknown }[] {
  switch (command.action) {
    case 'set_temperature':
      return [
        {
          path: 'temperature',
          body: {
            [command.args.heater === 'extruder' ? 'nozzle' : 'bed']:
              command.args.target_c,
          },
        },
      ]
    case 'set_fan':
      return [{ path: 'fan', body: { speed: command.args.percent } }]
    case 'set_light':
      return [{ path: 'light', body: { on: command.args.on } }]
    // apps/web/src/components/printer/controls-card.tsx: quiet=1, standard=2, fast=3.
    case 'set_speed':
      return [
        {
          path: 'speed',
          body: {
            mode: { silent: 1, standard: 2, sport: 3 }[command.args.level],
          },
        },
      ]
    // apps/web/src/components/printer/axes-card.tsx: X=1,Y=2,Z=3,ALL=4; home moveType=2.
    case 'home':
      return (
        command.args.axes.length === 3
          ? [4]
          : command.args.axes.map((axis) => ({ x: 1, y: 2, z: 3 })[axis])
      ).map((axis) => ({
        path: 'axis',
        body: { axis, moveType: 2, distance: 0 },
      }))
    // Existing printer-local file only; no server upload or download fallback.
    case 'start_print':
      return [
        {
          path: 'printer-files/print',
          body: { filename: command.args.file, sizeBytes: 0 },
        },
      ]
  }
}
