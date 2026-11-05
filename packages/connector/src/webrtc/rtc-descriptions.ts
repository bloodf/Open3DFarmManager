import {
  type RtcPeerRole,
  type RtcSessionBinding,
  rtcDtlsFingerprint,
} from '../../../farm-protocol/src/rtc-session-binding.ts'
type Description = Readonly<{ type: string; sdp: string }>
export type EffectiveRtcDescriptions = Readonly<{
  local: Description
  remote: Description
}>
/** Getter serialization is not hashed in place of transmitted SDP. Capture it once
 * to detect later replacement; role pins are checked independently below.
 */
export function captureEffectiveRtcDescriptions(
  local: Description | null,
  remote: Description | null,
): EffectiveRtcDescriptions {
  if (!local || !remote) throw Error('Effective descriptions missing')
  return Object.freeze({
    local: Object.freeze({ type: local.type, sdp: local.sdp }),
    remote: Object.freeze({ type: remote.type, sdp: remote.sdp }),
  })
}
export function checkEffectiveRtcDescriptions(
  binding: Pick<RtcSessionBinding, 'browser_dtls' | 'connector_dtls'>,
  role: RtcPeerRole,
  captured: EffectiveRtcDescriptions,
  current: EffectiveRtcDescriptions,
) {
  if (role !== 'browser' && role !== 'connector') throw Error('Wrong peer role')
  const localType = role === 'connector' ? 'offer' : 'answer',
    remoteType = role === 'connector' ? 'answer' : 'offer'
  if (
    current.local.type !== localType ||
    current.remote.type !== remoteType ||
    current.local.type !== captured.local.type ||
    current.remote.type !== captured.remote.type ||
    current.local.sdp !== captured.local.sdp ||
    current.remote.sdp !== captured.remote.sdp ||
    rtcDtlsFingerprint(current.local.sdp) !==
      (role === 'browser' ? binding.browser_dtls : binding.connector_dtls) ||
    rtcDtlsFingerprint(current.remote.sdp) !==
      (role === 'connector' ? binding.browser_dtls : binding.connector_dtls)
  )
    throw Error('Effective descriptions changed or role pins mismatch')
}
