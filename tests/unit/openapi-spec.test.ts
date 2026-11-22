import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createConfig, lint } from '@redocly/openapi-core'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import route from '../../apps/farm/server/api/integrations/v1/openapi.json.get.ts'
import { openApiDocumentFromYaml } from '../../apps/farm/server/utils/integrations/openapi-spec.ts'

const specPath = fileURLToPath(
  new URL('../../docs/api/openapi-v1.yaml', import.meta.url),
)
const source = await readFile(specPath, 'utf8')
const committed = parse(source) as {
  openapi: string
  servers: { url: string }[]
  paths: Record<string, Record<string, OperationObject>>
  components: {
    securitySchemes: {
      clientCredentials: {
        flows: { clientCredentials: { scopes: Record<string, string> } }
      }
    }
    schemas: Record<string, { enum?: string[] }>
    headers: Record<string, unknown>
  }
  webhooks: Record<string, unknown>
}
type OperationObject = {
  security?: Record<string, string[]>[]
  responses: Record<string, unknown>
}

const served = async () => {
  const response = await route({
    req: new Request(
      'https://farm.example.invalid/api/integrations/v1/openapi.json',
    ),
  } as never)
  return response
}

describe('integration API v1 OpenAPI spec', () => {
  it('passes the Redocly recommended-strict ruleset with no problems', async () => {
    const config = await createConfig({ extends: ['recommended-strict'] })
    const problems = await lint({ ref: specPath, config })
    expect(
      problems.map(
        (problem) =>
          `${problem.ruleId}: ${problem.message} at ${problem.location[0]?.pointer}`,
      ),
    ).toEqual([])
  })

  it('serves exactly the committed file as JSON, publicly', async () => {
    const response = await served()
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(
      'application/json; charset=utf-8',
    )
    const body = await response.text()
    expect(JSON.parse(body)).toStrictEqual(committed)
    expect(body).toBe(JSON.stringify(openApiDocumentFromYaml(source)))
  })

  it('documents the v1 base path, every scope and the plan decisions', () => {
    expect(committed.openapi).toBe('3.1.0')
    expect(committed.servers.map((server) => server.url)).toEqual([
      '/api/integrations/v1',
    ])
    expect(
      Object.keys(
        committed.components.securitySchemes.clientCredentials.flows
          .clientCredentials.scopes,
      ),
    ).toEqual([
      'printers:read',
      'files:read',
      'inventory:read',
      'jobs:read',
      'jobs:start',
      'jobs:write',
      'control:basic',
      'control:extended',
      'events:subscribe',
      'library:read',
      'library:write',
      'environment:read',
      'plates:confirm',
      'alerts:write',
      'camera:view',
    ])
    expect(Object.keys(committed.paths).sort()).toEqual(
      [
        '/openapi.json',
        '/oauth/token',
        '/printers',
        '/printers/status',
        '/printers/{printerId}/status',
        '/printers/{printerId}/files',
        '/printers/{printerId}/macros',
        '/printers/{printerId}/jobs',
        '/printers/{printerId}/actions',
        '/environment/measurements',
        '/inventory',
        '/library',
        '/library/settings',
        '/library/{itemId}',
        '/jobs',
        '/jobs/{jobId}',
        '/actions/{actionId}',
        '/resin/lots',
        '/resin/usage',
        '/resin/vats',
        '/webhooks',
        '/webhooks/{webhookId}',
        '/webhooks/{webhookId}/test',
      ].sort(),
    )
    expect(committed.components.schemas.RefusalCode?.enum).toEqual([
      'printer-busy',
      'not-ready',
      'wrong-state',
      'checksum-mismatch',
      'grant-revoked',
      'expired',
      'unsupported',
    ])
    expect(Object.keys(committed.components.headers)).toEqual(
      expect.arrayContaining([
        'RateLimit-Limit',
        'RateLimit-Remaining',
        'RateLimit-Reset',
        'Retry-After',
      ]),
    )
    expect(Object.keys(committed.webhooks)).toEqual(
      expect.arrayContaining([
        'job.ended',
        'inventory.changed',
        'printer.alert.raised',
      ]),
    )
  })

  it('keeps the spec and token endpoint public and everything else scoped', () => {
    for (const [path, operations] of Object.entries(committed.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        const security = operation.security
        if (path === '/openapi.json' || path === '/oauth/token') {
          expect(security, `${method} ${path}`).toEqual([])
          continue
        }
        // Unset security inherits the global client-credentials requirement.
        expect(security?.length ?? 1, `${method} ${path}`).toBeGreaterThan(0)
        expect(Object.keys(operation.responses), `${method} ${path}`).toContain(
          '401',
        )
        expect(Object.keys(operation.responses), `${method} ${path}`).toContain(
          '429',
        )
      }
    }
  })
})
