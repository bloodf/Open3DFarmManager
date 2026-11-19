// A small JSON Schema (2020-12 subset as used by openapi-v1.yaml) validator.
// Every object is closed: a property that no schema in scope names is an
// "undocumented" violation, whether or not the schema says
// additionalProperties. Schemas that declare no properties at all (a bare
// `type: object`) are free-form maps and are left open.
import { deref, type Schema } from './spec.ts'

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function typeMatches(value: unknown, type: string) {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    case 'array':
      return Array.isArray(value)
    case 'object':
      return isObject(value)
    default:
      return false
  }
}

const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b)

function formatOk(format: string, value: string) {
  if (format === 'uri') return URL.canParse(value)
  if (format === 'uri-reference')
    return URL.canParse(value, 'https://x.invalid')
  return true
}

function collect(
  rawSchema: Schema,
  value: unknown,
  path: string,
  out: string[],
): Set<string> {
  const schema = deref(rawSchema)
  const evaluated = new Set<string>()

  for (const sub of (schema.allOf ?? []) as Schema[])
    for (const key of collect(sub, value, path, out)) evaluated.add(key)

  for (const keyword of ['oneOf', 'anyOf'] as const) {
    const options = schema[keyword] as Schema[] | undefined
    if (!options) continue
    const matching = options.filter(
      (option) => validateValue(option, value, path).length === 0,
    )
    const ok =
      keyword === 'oneOf' ? matching.length === 1 : matching.length >= 1
    if (!ok) out.push(`${path}: matches ${matching.length} ${keyword} options`)
    for (const option of matching)
      for (const key of collect(option, value, path, [])) evaluated.add(key)
  }

  if ('const' in schema && !equal(schema.const, value))
    out.push(`${path}: expected const ${JSON.stringify(schema.const)}`)
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => equal(e, value)))
    out.push(`${path}: ${JSON.stringify(value)} not in enum`)

  const types = schema.type === undefined ? [] : [schema.type].flat()
  if (types.length && !types.some((type) => typeMatches(value, String(type)))) {
    out.push(
      `${path}: expected ${types.join('|')}, got ${JSON.stringify(value)}`,
    )
    return evaluated
  }

  if (typeof value === 'string') {
    const length = [...value].length
    if (typeof schema.minLength === 'number' && length < schema.minLength)
      out.push(`${path}: shorter than ${schema.minLength}`)
    if (typeof schema.maxLength === 'number' && length > schema.maxLength)
      out.push(`${path}: longer than ${schema.maxLength}`)
    if (
      typeof schema.pattern === 'string' &&
      !new RegExp(schema.pattern, 'u').test(value)
    )
      out.push(`${path}: does not match ${schema.pattern}`)
    if (typeof schema.format === 'string' && !formatOk(schema.format, value))
      out.push(`${path}: not a valid ${schema.format}`)
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum)
      out.push(`${path}: below ${schema.minimum}`)
    if (typeof schema.maximum === 'number' && value > schema.maximum)
      out.push(`${path}: above ${schema.maximum}`)
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems)
      out.push(`${path}: fewer than ${schema.minItems} items`)
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems)
      out.push(`${path}: more than ${schema.maxItems} items`)
    if (
      schema.uniqueItems === true &&
      new Set(value.map((item) => JSON.stringify(item))).size !== value.length
    )
      out.push(`${path}: items not unique`)
    if (isObject(schema.items))
      value.forEach((item, index) =>
        out.push(
          ...validateValue(schema.items as Schema, item, `${path}[${index}]`),
        ),
      )
  }
  if (isObject(value)) {
    for (const key of (schema.required ?? []) as string[])
      if (!(key in value)) out.push(`${path}.${key}: required`)
    const properties = (schema.properties ?? {}) as Record<string, Schema>
    for (const [key, sub] of Object.entries(properties)) {
      if (!(key in value)) continue
      evaluated.add(key)
      out.push(...validateValue(sub, value[key], `${path}.${key}`))
    }
    if (isObject(schema.additionalProperties))
      for (const [key, item] of Object.entries(value)) {
        if (key in properties) continue
        evaluated.add(key)
        out.push(
          ...validateValue(schema.additionalProperties, item, `${path}.${key}`),
        )
      }
    // A schema with no property list at all describes a free-form map.
    if (
      schema.type === 'object' &&
      !('properties' in schema) &&
      !schema.allOf &&
      !schema.oneOf &&
      !schema.anyOf &&
      schema.additionalProperties !== false
    )
      for (const key of Object.keys(value)) evaluated.add(key)
  }
  return evaluated
}

/** Violations of `value` against `schema`, closed-world. Empty means valid. */
export function validateValue(
  schema: Schema,
  value: unknown,
  path = '$',
): string[] {
  const out: string[] = []
  const evaluated = collect(schema, value, path, out)
  if (isObject(value))
    for (const key of Object.keys(value))
      if (!evaluated.has(key)) out.push(`${path}.${key}: undocumented field`)
  return out
}
