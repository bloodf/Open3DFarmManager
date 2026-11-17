import { parse } from 'yaml'

/**
 * Turns the committed `docs/api/openapi-v1.yaml` into the JSON document the
 * integration API publishes. The YAML file is the source of truth; nothing is
 * added, removed or reordered.
 */
export function openApiDocumentFromYaml(source: string): unknown {
  const document: unknown = parse(source, {
    schema: 'core',
    merge: false,
    uniqueKeys: true,
    prettyErrors: false,
  })
  if (
    typeof document !== 'object' ||
    document === null ||
    Array.isArray(document) ||
    typeof (document as { openapi?: unknown }).openapi !== 'string'
  )
    throw new Error('docs/api/openapi-v1.yaml is not an OpenAPI document')
  return document
}

/** Public response for `GET /api/integrations/v1/openapi.json`. */
export function openApiJsonResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'access-control-allow-origin': '*',
      'x-content-type-options': 'nosniff',
    },
  })
}
