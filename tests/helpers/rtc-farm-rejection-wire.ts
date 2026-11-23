import {
  decodeCommandV2,
  encodeCommandV2,
  signCommandV2,
} from '../../packages/farm-protocol/src/command-v2.ts'

import type { RtcRejectionKind } from './rtc-farm-rejections.ts'

// Same re-signed field substitutions as pause-cross-scope.test.ts. A changed
// scope must reach scope validation rather than merely fail signature checking.
export async function rejectionWire(
  kind: RtcRejectionKind,
  wire: string,
  privateKey: CryptoKey,
) {
  const { sig, ...command } = decodeCommandV2(wire)
  if (kind === 'tampered')
    return encodeCommandV2({ ...command, farm_id: crypto.randomUUID(), sig })
  if (kind === 'wrong-farm') command.farm_id = crypto.randomUUID()
  if (kind === 'wrong-assignment') command.assignment_id = crypto.randomUUID()
  if (kind === 'expired') {
    command.issued_at = Date.now() - 10000
    command.expires_at = command.issued_at + 1000
  }
  return encodeCommandV2(await signCommandV2(command, privateKey))
}
