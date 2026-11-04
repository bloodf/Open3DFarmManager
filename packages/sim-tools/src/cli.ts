import { Effect } from 'effect'
import { probePrinter } from './probe.ts'

const origin = process.env.SIM_SV06_URL ?? 'http://127.0.0.1:7125'
const deadline = Date.now() + 90_000
let ready = false
while (Date.now() < deadline) {
  try {
    await Effect.runPromise(probePrinter(origin))
    ready = true
    break
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}
if (!ready) {
  console.error(
    'SV06 simulator did not reach ready state within 90 seconds. Check the Compose logs.',
  )
  process.exitCode = 1
} else console.log('SIM_SMOKE_OK: sv06 Moonraker connected and Klipper ready')
