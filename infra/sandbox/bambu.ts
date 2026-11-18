import { startBambuSimulator } from '../../packages/sim-tools/src/bambu-simulator.ts'

const simulator = await startBambuSimulator({
  host: '0.0.0.0',
  port: 9999,
  initialState: 'IDLE',
})
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void simulator.close())
}
