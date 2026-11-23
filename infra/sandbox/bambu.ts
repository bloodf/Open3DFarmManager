import { startBambuSimulator } from '../../packages/sim-tools/src/bambu-simulator.ts'
import { syntheticBambuTls } from './bambu-synthetic-identity.ts'
const accessCode = process.env.SANDBOX_BAMBU_ACCESS_CODE
if (!accessCode) throw new Error('Missing synthetic Bambu access code')

const simulator = await startBambuSimulator({
  host: '0.0.0.0',
  port: 9999,
  ftpsPort: 9998,
  accessCode,
  credentials: { username: 'bblp', password: accessCode },
  initialState: 'IDLE',
  // Fixed synthetic identity: scripts/sandbox-seed.ts pins its fingerprint.
  tls: syntheticBambuTls,
})
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void simulator.close())
}
