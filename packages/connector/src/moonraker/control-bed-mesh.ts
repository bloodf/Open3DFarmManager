import { DriverRefusalError } from '../control/driver-refusal.ts'
import { z } from 'zod'
import { BedMeshArguments } from '../../../farm-protocol/src/control-actions.ts'

/**
 * Moonraker adapter for the signed `bed_mesh` action: calibrate, load, save,
 * remove and clear. The script is built only from validated arguments (a
 * fixed op and a `^[A-Za-z0-9_]{1,32}$` profile name), never from wire text.
 * State refusals come from one read taken just before the single send; the
 * caller never retries an uncertain command.
 */

export type BedMeshRefusalReason =
  'state' | 'unsupported-action' | 'invalid-command'

/** Thrown before any write; the dispatcher reports it as not sent. */
export class BedMeshRefused extends DriverRefusalError {
  constructor(refusal: BedMeshRefusalReason) {
    super(refusal, `Bed mesh refused: ${refusal}`)
    this.name = 'BedMeshRefused'
  }
}

/** Only a printer that lists the `bed_mesh` object has anything to calibrate. */
export const bedMeshSupported = (objects: readonly string[] | undefined) =>
  !!objects?.includes('bed_mesh')

/** The one G-code script for an op, from validated arguments only. */
export function bedMeshScript(args: unknown): string {
  const parsed = BedMeshArguments.safeParse(args)
  if (!parsed.success) throw new BedMeshRefused('invalid-command')
  const { op, profile } = parsed.data
  switch (op) {
    case 'calibrate':
      return profile
        ? `BED_MESH_CALIBRATE PROFILE=${profile}`
        : 'BED_MESH_CALIBRATE'
    case 'load':
      return `BED_MESH_PROFILE LOAD=${profile}`
    case 'save':
      return `BED_MESH_PROFILE SAVE=${profile}`
    case 'remove':
      return `BED_MESH_PROFILE REMOVE=${profile}`
    case 'clear':
      return 'BED_MESH_CLEAR'
  }
}

const IDLE = ['standby', 'complete', 'cancelled'] as const
/** One printer.objects.query reply for the fields below, nothing else. */
const MeshSnapshot = z.object({
  status: z.object({
    webhooks: z.object({ state: z.string() }),
    print_stats: z.object({ state: z.string() }),
    toolhead: z.object({ homed_axes: z.string() }),
    bed_mesh: z.object({
      profiles: z.record(z.string(), z.unknown()),
      mesh_matrix: z.array(z.array(z.number())),
    }),
  }),
})
export type BedMeshState = Readonly<{
  ready: boolean
  printState: string
  homedAxes: string
  profiles: readonly string[]
  hasMesh: boolean
}>

export function bedMeshQueryWire(id: number): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'printer.objects.query',
    params: {
      objects: {
        webhooks: ['state'],
        print_stats: ['state'],
        toolhead: ['homed_axes'],
        bed_mesh: ['profiles', 'mesh_matrix'],
      },
    },
  })
}

/** Parses a query reply; anything else is "unknown state", which refuses. */
export function parseBedMeshState(result: unknown): BedMeshState {
  const parsed = MeshSnapshot.safeParse(result)
  if (!parsed.success) throw new BedMeshRefused('state')
  const { webhooks, print_stats, toolhead, bed_mesh } = parsed.data.status
  return Object.freeze({
    ready: webhooks.state === 'ready',
    printState: print_stats.state,
    homedAxes: toolhead.homed_axes,
    profiles: Object.freeze(Object.keys(bed_mesh.profiles)),
    hasMesh: bed_mesh.mesh_matrix.length > 0,
  })
}

/**
 * Connector-side refusal. Every op needs a ready, stopped printer: a mesh
 * change mid-print would shift the first layers' compensation. Calibrate also
 * needs X, Y and Z homed; load and remove need the profile to exist; save
 * needs a mesh to save.
 */
export function refuseBedMesh(args: unknown, state: BedMeshState | undefined) {
  const parsed = BedMeshArguments.safeParse(args)
  if (!parsed.success) throw new BedMeshRefused('invalid-command')
  if (!state?.ready || !(IDLE as readonly string[]).includes(state.printState))
    throw new BedMeshRefused('state')
  const { op, profile } = parsed.data
  if (op === 'calibrate' && !/^(?=.*x)(?=.*y)(?=.*z)/.test(state.homedAxes))
    throw new BedMeshRefused('state')
  if (
    (op === 'load' || op === 'remove') &&
    !state.profiles.includes(profile ?? '')
  )
    throw new BedMeshRefused('state')
  if (op === 'save' && !state.hasMesh) throw new BedMeshRefused('state')
}
