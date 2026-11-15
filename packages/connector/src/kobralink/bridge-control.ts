import { z } from 'zod'

/**
 * Native controls in packages/shared/src/control.ts and
 * apps/api/src/core/core.controller.ts at NatHacks/Kobralink revision
 * 5a5e5d9b1e3b9ad4f0760672cf7dc4bb8c85f5e1. Keep separate from the shared
 * signed-command vocabulary, which has no AMS, ACE or jog actions.
 */
export const KOBRALINK_BRIDGE_CONTROLS = Object.freeze([
  'temperature',
  'fan',
  'light',
  'speed',
  'axis',
  'axis_off',
  'ams_slot',
  'ams_feed',
  'ace_auto_feed',
  'ace_dry',
] as const)
export const KobraLinkBridgeCommand = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('temperature'),
    args: z
      .strictObject({
        nozzle: z.number().finite().min(0).max(320).optional(),
        bed: z.number().finite().min(0).max(120).optional(),
      })
      .refine((v) => v.nozzle !== undefined || v.bed !== undefined),
  }),
  z.strictObject({
    action: z.literal('fan'),
    args: z.strictObject({ speed: z.number().int().min(0).max(100) }),
  }),
  z.strictObject({
    action: z.literal('light'),
    args: z.strictObject({
      on: z.boolean(),
      brightness: z.number().int().min(0).max(100).optional(),
    }),
  }),
  z.strictObject({
    action: z.literal('speed'),
    args: z.strictObject({ mode: z.number().int().min(1).max(3) }),
  }),
  z.strictObject({
    action: z.literal('axis'),
    args: z.strictObject({
      axis: z.number().int().min(1).max(4),
      moveType: z.number().int().min(0).max(2),
      distance: z.number().finite().min(0).max(100).default(0),
    }),
  }),
  z.strictObject({ action: z.literal('axis_off'), args: z.strictObject({}) }),
  z.strictObject({
    action: z.literal('ams_slot'),
    args: z.strictObject({
      index: z.number().int().min(0).max(19),
      type: z
        .string()
        .trim()
        .min(1)
        .max(16)
        .transform((v) => v.toUpperCase()),
      color: z.tuple([
        z.number().int().min(0).max(255),
        z.number().int().min(0).max(255),
        z.number().int().min(0).max(255),
      ]),
    }),
  }),
  z.strictObject({
    action: z.literal('ams_feed'),
    args: z.strictObject({
      slotIndex: z.number().int().min(0).max(19),
      type: z.union([z.literal(1), z.literal(2)]),
    }),
  }),
  z.strictObject({
    action: z.literal('ace_auto_feed'),
    args: z.strictObject({
      aceId: z.number().int().min(0).max(3),
      on: z.boolean(),
    }),
  }),
  z.strictObject({
    action: z.literal('ace_dry'),
    args: z.strictObject({
      action: z.enum(['start', 'stop']),
      aceId: z.number().int().min(0).max(3).optional(),
      targetTemp: z.number().int().min(30).max(80).default(45),
      duration: z.number().int().min(10).max(1440).default(240),
    }),
  }),
])
export type KobraLinkBridgeCommand = z.input<typeof KobraLinkBridgeCommand>
export const KOBRALINK_BRIDGE_PATHS = {
  temperature: 'temperature',
  fan: 'fan',
  light: 'light',
  speed: 'speed',
  axis: 'axis',
  axis_off: 'axis/off',
  ams_slot: 'ams/slot',
  ams_feed: 'ams/feed',
  ace_auto_feed: 'ace/auto-feed',
  ace_dry: 'ace/dry',
} satisfies Record<KobraLinkBridgeCommand['action'], string>
