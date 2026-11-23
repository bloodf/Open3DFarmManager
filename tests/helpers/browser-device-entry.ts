// Test bundle of the actual browser implementation and shared protocol.
export * from '../../packages/farm-protocol/src/index.ts'
export { loadOrCreateDeviceKey } from '../../apps/farm/app/utils/device-key.ts'
export {
  signCommandV2,
  encodeCommandV2,
} from '../../packages/farm-protocol/src/command-v2.ts'
export { signPauseAdmissionProof } from '../../packages/farm-protocol/src/pause-capability.ts'
export { signControlSessionProof } from '../../packages/farm-protocol/src/control-session-binding.ts'
