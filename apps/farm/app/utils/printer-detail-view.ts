// SPDX-License-Identifier: MIT
import type { z } from 'zod'
import type { PrinterDetailCapability } from '../../../../packages/farm-protocol/src/printer-detail.ts'

export type DetailCapability = z.infer<typeof PrinterDetailCapability>
export type DetailTabId =
  | 'painel'
  | 'console'
  | 'arquivos'
  | 'fila'
  | 'malha'
  | 'configuracao'
  | 'sistema'
  | 'historico'

type DetailTab = {
  id: DetailTabId
  label: string
  /** Any one of these capabilities enables the tab; none means always on. */
  needs: readonly DetailCapability[]
}

export const DETAIL_TABS: readonly DetailTab[] = [
  { id: 'painel', label: 'Painel', needs: [] },
  { id: 'console', label: 'Console', needs: ['console'] },
  { id: 'arquivos', label: 'Arquivos', needs: ['files'] },
  { id: 'fila', label: 'Fila', needs: ['job-queue'] },
  { id: 'malha', label: 'Malha', needs: ['bed-mesh'] },
  // Configuration files are read through the file capability.
  { id: 'configuracao', label: 'Configuração', needs: ['files'] },
  { id: 'sistema', label: 'Sistema', needs: ['system', 'updates', 'power'] },
  { id: 'historico', label: 'Histórico', needs: ['job'] },
]

export const DEFAULT_UNSUPPORTED_REASON =
  'Esta impressora não anuncia este recurso.'

export type UnavailableTab = DetailTab & { reason: string }

/**
 * Splits the tabs by advertised capability. A tab that is not advertised stays
 * out of the tab list and is listed with the catalog reason when one exists.
 * Without an advertisement (no detail feed yet) every optional tab is
 * unavailable: a capability is never assumed.
 */
export function detailTabs(
  capabilities: readonly DetailCapability[] | undefined,
  reasons: Readonly<Partial<Record<DetailCapability, string>>> = {},
) {
  const available: DetailTab[] = []
  const unavailable: UnavailableTab[] = []
  for (const tab of DETAIL_TABS) {
    if (
      !tab.needs.length ||
      tab.needs.some((need) => capabilities?.includes(need))
    ) {
      available.push(tab)
      continue
    }
    const reason =
      tab.needs.map((need) => reasons[need]).find(Boolean) ??
      DEFAULT_UNSUPPORTED_REASON
    unavailable.push({ ...tab, reason })
  }
  return { available, unavailable }
}

export type HeaterReading = {
  name: string
  temperature?: number
  target?: number
  /** Fraction between 0 and 1. */
  power?: number
  /** Hard ceiling reported by the printer; commands never exceed it. */
  maxTemp?: number
}
export type HeaterSample = {
  time: number
  temperature: number
  target?: number
}
export type HeaterHistory = Readonly<Record<string, readonly HeaterSample[]>>

export const HISTORY_WINDOW_MS = 10 * 60_000

const labels: Record<string, string> = {
  extruder: 'Bico',
  heater_bed: 'Mesa',
  bed: 'Mesa',
  chamber: 'Câmara',
}
export function heaterLabel(name: string): string {
  return labels[name] ?? name
}
/** The command argument for a heater name the printer reports. */
export function commandHeaterName(name: string): string {
  return name === 'heater_bed' ? 'bed' : name
}

function window(samples: readonly HeaterSample[], now: number) {
  return samples.filter(
    ({ time, temperature }) =>
      Number.isFinite(time) &&
      Number.isFinite(temperature) &&
      time >= now - HISTORY_WINDOW_MS &&
      time <= now,
  )
}

/** Adds samples to a heater history, dropping duplicates and anything older than ten minutes. */
export function mergeSamples(
  history: HeaterHistory,
  heater: string,
  samples: readonly HeaterSample[],
  now: number,
): HeaterHistory {
  const byTime = new Map<number, HeaterSample>()
  for (const sample of window([...(history[heater] ?? []), ...samples], now))
    byTime.set(sample.time, sample)
  return {
    ...history,
    [heater]: [...byTime.values()].sort((a, b) => a.time - b.time),
  }
}

/** Clamps a requested target to 0..maxTemp and rounds it; undefined when unusable. */
export function clampTarget(
  input: string | number,
  maxTemp: number | undefined,
): number | undefined {
  if (typeof input === 'string' && input.trim() === '') return undefined
  const value = Math.round(Number(input))
  if (!Number.isFinite(value)) return undefined
  const ceiling =
    maxTemp !== undefined && Number.isFinite(maxTemp) ? maxTemp : undefined
  return Math.max(0, ceiling === undefined ? value : Math.min(value, ceiling))
}

export function temperatureText(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value)
    ? 'Indisponível'
    : `${value.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} °C`
}
export function powerText(power: number | undefined): string {
  return power === undefined || !Number.isFinite(power)
    ? 'Indisponível'
    : `${Math.round(Math.min(1, Math.max(0, power)) * 100)} %`
}

/** Ceilings the Connector enforces when the printer reports none. */
const DEFAULT_MAX_TEMP = { extruder: 300, heater_bed: 120 } as const

type ObservedTemperatures = {
  toolTemperatureCelsius?: number
  bedTemperatureCelsius?: number
  machine?: {
    maxHotendTemperatureCelsius?: Readonly<Record<string, number>>
    maxBedTemperatureCelsius?: number
  }
}

/** Heaters the observation reports. Targets and power arrive with the detail feed. */
export function heatersFromObservation(
  state: ObservedTemperatures,
): HeaterReading[] {
  const heaters: HeaterReading[] = []
  if (state.toolTemperatureCelsius !== undefined)
    heaters.push({
      name: 'extruder',
      temperature: state.toolTemperatureCelsius,
      maxTemp:
        state.machine?.maxHotendTemperatureCelsius?.['0'] ??
        DEFAULT_MAX_TEMP.extruder,
    })
  if (state.bedTemperatureCelsius !== undefined)
    heaters.push({
      name: 'heater_bed',
      temperature: state.bedTemperatureCelsius,
      maxTemp:
        state.machine?.maxBedTemperatureCelsius ?? DEFAULT_MAX_TEMP.heater_bed,
    })
  return heaters
}

/** Current readings as history samples, one per heater with a temperature. */
export function samplesFromHeaters(
  heaters: readonly HeaterReading[],
  time: number,
): Record<string, HeaterSample> {
  return Object.fromEntries(
    heaters.flatMap(({ name, temperature, target }) =>
      temperature === undefined
        ? []
        : [
            [
              name,
              {
                time,
                temperature,
                ...(target === undefined ? {} : { target }),
              },
            ],
          ],
    ),
  )
}
