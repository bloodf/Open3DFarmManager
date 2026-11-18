import {
  startBambuSimulator,
  syntheticBambuTls,
} from '../../packages/sim-tools/src/bambu-simulator.ts'

const simulator = await startBambuSimulator({
  host: '0.0.0.0',
  port: 9999,
  initialState: 'IDLE',
  // Fixed synthetic identity: scripts/sandbox-seed.ts pins its fingerprint.
  tls: syntheticBambuTls,
})
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void simulator.close())
}
