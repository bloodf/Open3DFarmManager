/// <reference path="../../../raw-imports.d.ts" />
import { defineEventHandler } from 'nuxt/server'
// Bundled at build time: the runtime image does not ship docs/.
import source from 'raw:../../../../../../docs/api/openapi-v1.yaml'
import {
  openApiDocumentFromYaml,
  openApiJsonResponse,
} from '../../../utils/integrations/openapi-spec.ts'

const body = JSON.stringify(openApiDocumentFromYaml(source))

/** Public, unauthenticated: the published v1 contract, unchanged, as JSON. */
export default defineEventHandler(() => openApiJsonResponse(body))
