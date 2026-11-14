import {
  discoveryRequest,
  decodeDiscoveryResult,
} from '../../../../../packages/farm-protocol/src/configuration-discovery.ts'
import type { ConfigurationBrowserPeer } from './configuration-browser-peer.ts'

// Sign the returned status frame with the existing admin/owner capability flow.
export { discoveryRequest, decodeDiscoveryResult }
export function sendDiscoveryRequest(
  peer: Pick<ConfigurationBrowserPeer, 'sendMessage'>,
  signed: { frame: string; capability: string; admission: string },
): boolean {
  return peer.sendMessage({ v: 1, t: 'discovery', ...signed })
}
