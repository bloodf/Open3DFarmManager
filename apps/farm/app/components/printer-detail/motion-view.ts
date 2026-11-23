// SPDX-License-Identifier: MIT
import { formatNumber } from '../../utils/ui-format.ts'
/** Pure helpers of the motion panel: steps, labels and readout text. */

export type MotionControl =
  'home' | 'jog' | 'motors_off' | 'z_babystep' | 'set_factor'
export type MotionAvailability = Readonly<{
  available: boolean
  reason?: string
}>
export type MotionAvailabilityMap = Readonly<
  Partial<Record<MotionControl, MotionAvailability>>
>
export type JogAxis = 'x' | 'y' | 'z'

export const JOG_STEPS_MM: readonly number[] = [0.1, 1, 10, 100]
export const JOG_FEEDS_MM_MIN: readonly number[] = [600, 1800, 3000, 6000]
export const BABYSTEP_STEPS_MM: readonly number[] = [0.005, 0.01, 0.025, 0.05]
export const DEFAULT_MOTION_REASON = 'Comando indisponível.'

const number = (value: number) =>
  formatNumber(value, { maximumFractionDigits: 3 })
export const mmText = (value: number) => `${number(value)} mm`

/** `X: 10,25 mm`, or `X: Indisponível` when the printer reports no position. */
export function positionText(
  axis: JogAxis,
  position: readonly number[] | undefined,
): string {
  const value = position?.['xyz'.indexOf(axis)]
  return `${axis.toUpperCase()}: ${
    value === undefined || !Number.isFinite(value)
      ? 'Indisponível'
      : mmText(value)
  }`
}

/** Axes known not to be homed; empty when the printer reports nothing. */
export function unhomedAxes(homed: readonly string[] | undefined): JogAxis[] {
  if (!homed) return []
  return (['x', 'y', 'z'] as const).filter((axis) => !homed.includes(axis))
}

/** Integer within bounds, or undefined (for the speed and flow inputs). */
export function percentInRange(
  input: string | number,
  min: number,
  max: number,
): number | undefined {
  if (typeof input === 'string' && input.trim() === '') return undefined
  const value = Number(input)
  return Number.isInteger(value) && value >= min && value <= max
    ? value
    : undefined
}

/** The signed jog distance and feed for a pad press, or undefined if the selection is not offered. */
export function jogRequest(
  sign: 1 | -1,
  step: string | number,
  feed: string | number,
): { distanceMm: number; feed: number } | undefined {
  const size = Number(step)
  const speed = Number(feed)
  return JOG_STEPS_MM.includes(size) && JOG_FEEDS_MM_MIN.includes(speed)
    ? { distanceMm: Number((sign * size).toFixed(3)), feed: speed }
    : undefined
}

/** The signed Z babystep for a button press, or undefined if the size is not offered. */
export function babystepDelta(
  sign: 1 | -1,
  size: string | number,
): number | undefined {
  const value = Number(size)
  return BABYSTEP_STEPS_MM.includes(value)
    ? Number((sign * value).toFixed(3))
    : undefined
}

/** Validates the speed and flow fields; `note` is the pt-BR message for the first bad one. */
export function factorRequest(
  speed: string | number,
  flow: string | number,
): { speedPct: number; flowPct: number } | { note: string } {
  const speedPct = percentInRange(speed, 10, 300)
  if (speedPct === undefined)
    return {
      note: 'Informe a velocidade como número inteiro entre 10 e 300 %.',
    }
  const flowPct = percentInRange(flow, 50, 150)
  if (flowPct === undefined)
    return { note: 'Informe o fluxo como número inteiro entre 50 e 150 %.' }
  return { speedPct, flowPct }
}
