/** Scopes exactly as declared in docs/api/openapi-v1.yaml (and the DB check). */
export const INTEGRATION_SCOPES = [
  'printers:read',
  'files:read',
  'inventory:read',
  'jobs:read',
  'jobs:start',
  'control:basic',
  'control:extended',
  'events:subscribe',
  'jobs:write',
  'library:read',
  'library:write',
  // Appended last: token scope masks use each scope's index in this list.
  'environment:read',
  'plates:confirm',
  'alerts:write',
  'camera:view',
  'inventory:write',
  'environment:control',
  'alerts:manage',
] as const
export type IntegrationScope = (typeof INTEGRATION_SCOPES)[number]
