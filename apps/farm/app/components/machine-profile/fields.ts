export type NumericField =
  | 'nozzleDiameterMm'
  | 'bedSizeXMm'
  | 'bedSizeYMm'
  | 'bedSizeZMm'
  | 'maxHotendTemperatureCelsius'
  | 'maxBedTemperatureCelsius'
export type TextField = 'model' | 'kinematics'
export type ProfileField = NumericField | TextField

export interface ProfileValues {
  model: string | null
  nozzleDiameterMm: number | null
  bedSizeXMm: number | null
  bedSizeYMm: number | null
  bedSizeZMm: number | null
  maxHotendTemperatureCelsius: number | null
  maxBedTemperatureCelsius: number | null
  kinematics: string | null
}
export interface ProfileOverride extends ProfileValues {
  compatibleModels: string[]
  notes: string | null
}
export type FieldSource = 'override' | 'detected' | 'unknown'
export interface ProfileView {
  assignmentId: string
  detected: ProfileValues
  override: ProfileOverride
  effective: {
    values: ProfileValues
    sources: Record<ProfileField, FieldSource>
    compatibleModels: string[]
    notes: string | null
  }
  updatedBy: string | null
  updatedAt: number | null
}

export const PROFILE_FIELDS: readonly {
  key: ProfileField
  label: string
  kind: 'text' | 'number'
}[] = [
  { key: 'model', label: 'Modelo', kind: 'text' },
  { key: 'kinematics', label: 'Cinemática', kind: 'text' },
  { key: 'nozzleDiameterMm', label: 'Diâmetro do bico (mm)', kind: 'number' },
  { key: 'bedSizeXMm', label: 'Mesa, largura X (mm)', kind: 'number' },
  { key: 'bedSizeYMm', label: 'Mesa, profundidade Y (mm)', kind: 'number' },
  { key: 'bedSizeZMm', label: 'Altura máxima Z (mm)', kind: 'number' },
  {
    key: 'maxHotendTemperatureCelsius',
    label: 'Temperatura máxima do hotend (°C)',
    kind: 'number',
  },
  {
    key: 'maxBedTemperatureCelsius',
    label: 'Temperatura máxima da mesa (°C)',
    kind: 'number',
  },
]

export const SOURCE_LABELS: Record<FieldSource, string> = {
  override: 'Definido pelo proprietário',
  detected: 'Detectado',
  unknown: 'Sem informação',
}

export const displayValue = (value: string | number | null) =>
  value === null ? 'Sem informação' : String(value)

/** Form text for one override value; an empty field means "use the detected value". */
export const toFormText = (value: string | number | null) =>
  value === null ? '' : String(value)

export interface ProfileForm {
  values: Record<ProfileField, string>
  compatibleModels: string
  notes: string
}

export function formFromOverride(override: ProfileOverride): ProfileForm {
  const values = {} as Record<ProfileField, string>
  for (const { key } of PROFILE_FIELDS) values[key] = toFormText(override[key])
  return {
    values,
    compatibleModels: override.compatibleModels.join('\n'),
    notes: override.notes ?? '',
  }
}

/** Builds the edit body; returns the invalid field labels instead when a number is wrong. */
export function bodyFromForm(
  form: ProfileForm,
): { ok: true; body: ProfileOverride } | { ok: false; invalid: string[] } {
  const body = {} as Record<string, unknown>
  const invalid: string[] = []
  for (const { key, label, kind } of PROFILE_FIELDS) {
    const text = form.values[key].trim()
    if (!text) body[key] = null
    else if (kind === 'text') body[key] = text
    else {
      const number = Number(text.replace(',', '.'))
      if (Number.isFinite(number) && number > 0) body[key] = number
      else invalid.push(label)
    }
  }
  if (invalid.length) return { ok: false, invalid }
  body['compatibleModels'] = form.compatibleModels
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  body['notes'] = form.notes.trim() || null
  return { ok: true, body: body as unknown as ProfileOverride }
}
