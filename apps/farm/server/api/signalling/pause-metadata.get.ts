import { defineEventHandler } from 'nuxt/server'
import { pauseSignallingMetadata } from '../../services/signalling-runtime-bootstrap.ts'
import { signallingMetadataResponse } from '../../services/signalling-metadata.ts'

/** Advisory public availability only. */
export default defineEventHandler((event) =>
  signallingMetadataResponse(event, pauseSignallingMetadata()),
)
