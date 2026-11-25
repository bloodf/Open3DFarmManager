// Normalises a model's cited objects into farm fields. A missing or malformed
// optional reading stays unknown and never withdraws the print status.
import { z } from 'zod'
import { QIDI_PROFILES, type QidiModel } from './profiles.ts'

// Klipper get_status: fan `speed` and output_pin `value` are both 0..1.
// QIDITECH/klipper@653d7a8f6ec4700ec02c2319888ad98a92c1a0c3
// klippy/extras/{fan,fan_generic,output_pin}.py
const Level = z.number().min(0).max(1)
const Celsius = z.number().finite()
const Text = z.string().trim().min(1).max(64)

const BOXES = 4
const SLOTS_PER_BOX = 4

function percent(name: string, object: Record<string, unknown> | undefined) {
  const level = Level.safeParse(
    object?.[name.startsWith('output_pin ') ? 'value' : 'speed'],
  )
  return level.success ? Math.round(level.data * 100) : undefined
}

/** Colours use the `#RRGGBB` form of config/officiall_filas_list.cfg. */
function colorHex(value: unknown) {
  const first: unknown = Array.isArray(value) ? value[0] : undefined
  return typeof first === 'string' && /^#[0-9a-f]{6}$/i.test(first)
    ? `${first.slice(1).toUpperCase()}FF`
    : undefined
}

// QIDITECH/QIDIStudio@21d47457919212b8af3f97705716c261b97be559
// src/slic3r/GUI/QDSDeviceManager.cpp, updateBoxDataByJson: the fields sit in
// `box` when that is an object. Only occupied slots of reported boxes count.
// The external spool has no presence field, so it is not reported.
function boxMaterials(status: Record<string, unknown> | undefined) {
  if (!status) return undefined
  const nested = z.record(z.string(), z.unknown()).safeParse(status.box)
  const box = nested.success ? nested.data : status
  const count = z
    .number()
    .int()
    .min(1)
    .max(BOXES)
    .safeParse(status.box_count ?? box.box_count)
  if (!count.success) return undefined
  const materials = []
  for (let unit = 0; unit < count.data; unit++)
    for (let slot = 0; slot < SLOTS_PER_BOX; slot++) {
      const inserted = box[`box${unit}_box_inserted_${slot}`]
      if (!Number.isInteger(inserted) || inserted === 0) continue
      const prefix = `box${unit}_filament_info_${slot}_`
      const type = Text.safeParse(box[`${prefix}filament_type`])
      const color = colorHex(box[`${prefix}color_rgb_str`])
      materials.push({
        slot: `QIDI Box ${unit + 1}, slot ${slot + 1}`,
        ...(type.success ? { materialType: type.data } : {}),
        ...(color ? { colorHex: color } : {}),
      })
    }
  return materials.length ? materials : undefined
}

type Objects = Readonly<{
  fan?: Record<string, unknown> | undefined
  auxFans?: readonly (Record<string, unknown> | undefined)[]
  chamberFan?: Record<string, unknown> | undefined
  chamber?: Record<string, unknown> | undefined
  box?: Record<string, unknown> | undefined
}>

export function qidiReadings(model: QidiModel, state: Objects) {
  const profile = QIDI_PROFILES[model]
  const part = percent(profile.partFan, state.fan)
  const [aux, ...otherAux] = profile.auxFans.map((name, index) =>
    percent(name, state.auxFans?.[index]),
  )
  const chamberFan =
    profile.chamberFan && percent(profile.chamberFan, state.chamberFan)
  const fans = {
    ...(part === undefined ? {} : { part }),
    ...(aux !== undefined && otherAux.every((value) => value === aux)
      ? { aux }
      : {}),
    ...(typeof chamberFan === 'number' ? { chamber: chamberFan } : {}),
  }
  const temperature = Celsius.safeParse(state.chamber?.temperature)
  const target = Celsius.safeParse(state.chamber?.target)
  const materials = profile.box ? boxMaterials(state.box) : undefined
  return {
    ...(Object.keys(fans).length ? { fans } : {}),
    ...(temperature.success
      ? { chamberTemperatureCelsius: temperature.data }
      : {}),
    ...(target.success ? { chamberTargetCelsius: target.data } : {}),
    ...(materials ? { materials } : {}),
  }
}
