import manifest from '../../package.json' with { type: 'json' }
import { CONNECTOR_PROTOCOL_REVISION } from '../../../farm-protocol/src/version.ts'

export const connectorVersionMetadata = Object.freeze({
  connectorVersion: manifest.version,
  protocolRevision: CONNECTOR_PROTOCOL_REVISION,
})
