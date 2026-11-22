import { startBambuSimulator } from '../../packages/sim-tools/src/bambu-simulator.ts'
import { syntheticBambuTls } from './bambu-synthetic-identity.ts'
import { readFileSync } from 'node:fs'

const { accessCode } = JSON.parse(
  readFileSync('/sandbox/bambu-credential.json', 'utf8'),
) as { accessCode: string }

const simulator = await startBambuSimulator({
  host: '0.0.0.0',
  port: 9999,
  ftpsPort: 9998,
  accessCode,
  initialState: 'IDLE',
  // Fixed synthetic identity: scripts/sandbox-seed.ts pins its fingerprint.
  tls: syntheticBambuTls,
})
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void simulator.close())
}
