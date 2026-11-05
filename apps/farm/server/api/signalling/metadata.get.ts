import { defineEventHandler } from 'nuxt/server'
import { signallingMetadata } from '../../services/signalling-runtime-bootstrap.ts'
import { signallingMetadataResponse } from '../../services/signalling-metadata.ts'

/** Public availability metadata only; no session, proof or credentials are returned. */
export default defineEventHandler((event) =>
  signallingMetadataResponse(event, signallingMetadata()),
)
