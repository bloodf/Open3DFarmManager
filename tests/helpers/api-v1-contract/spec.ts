// Loads docs/api/openapi-v1.yaml and walks it: every operation and every
// documented status code, with $refs resolved. The contract test is driven by
// this walk, so a path or status added to the spec has no scenario until one
// is written and the test fails.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

export type Json = unknown
export type Schema = Record<string, unknown>

export interface HeaderSpec {
  name: string
  schema: Schema
}
export interface ResponseSpec {
  status: string
  description: string
  headers: HeaderSpec[]
  /** media type -> schema, empty for bodiless responses */
  content: Record<string, Schema>
}
export interface OperationSpec {
  key: string
  method: string
  path: string
  operationId: string
  security: string[][]
  requestBody?: { required: boolean; content: Record<string, Schema> }
  responses: ResponseSpec[]
}

export const specPath = fileURLToPath(
  new URL('../../../docs/api/openapi-v1.yaml', import.meta.url),
)
export const spec = parse(readFileSync(specPath, 'utf8')) as Schema

export function resolveRef(ref: string): Schema {
  if (!ref.startsWith('#/')) throw new Error(`Unsupported $ref ${ref}`)
  let node: unknown = spec
  for (const part of ref.slice(2).split('/'))
    node = (node as Record<string, unknown>)[
      part.replaceAll('~1', '/').replaceAll('~0', '~')
    ]
  if (node === undefined) throw new Error(`Dangling $ref ${ref}`)
  return node as Schema
}

export function deref(node: Schema): Schema {
  let current = node
  while (typeof current.$ref === 'string') {
    const { $ref, ...siblings } = current
    current = { ...resolveRef($ref), ...siblings }
  }
  return current
}

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch']

export function operations(): OperationSpec[] {
  const out: OperationSpec[] = []
  const paths = spec.paths as Record<string, Record<string, Schema>>
  for (const [path, item] of Object.entries(paths)) {
    for (const method of METHODS) {
      const op = item[method]
      if (!op) continue
      const security = (op.security ?? spec.security ?? []) as Record<
        string,
        string[]
      >[]
      const body = op.requestBody ? deref(op.requestBody as Schema) : undefined
      const responses = Object.entries(op.responses as Record<string, Schema>)
        .map(([status, raw]) => {
          const response = deref(raw)
          return {
            status,
            description: String(response.description ?? ''),
            headers: Object.entries(
              (response.headers ?? {}) as Record<string, Schema>,
            ).map(([name, header]) => ({
              name,
              schema: deref(deref(header).schema as Schema),
            })),
            content: Object.fromEntries(
              Object.entries(
                (response.content ?? {}) as Record<string, Schema>,
              ).map(([type, media]) => [
                type,
                (media as { schema: Schema }).schema,
              ]),
            ),
          }
        })
        .sort((a, b) => a.status.localeCompare(b.status))
      out.push({
        key: `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase(),
        path,
        operationId: String(op.operationId),
        security: security.map((entry) => Object.values(entry).flat()),
        ...(body
          ? {
              requestBody: {
                required: body.required === true,
                content: Object.fromEntries(
                  Object.entries(body.content as Record<string, Schema>).map(
                    ([type, media]) => [
                      type,
                      (media as { schema: Schema }).schema,
                    ],
                  ),
                ),
              },
            }
          : {}),
        responses,
      })
    }
  }
  return out
}
