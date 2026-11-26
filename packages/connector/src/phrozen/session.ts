import {
  readPhrozenPrinterBinding,
  type PrinterBinding,
} from '../control/printer-binding.ts'
import { connectPhrozen } from './index.ts'
import type { PhrozenOperationLock } from './operations.ts'

// One lock per provisioned printer for the life of the Connector process: an
// uncertain write holds every later one, across sessions. A person checks the
// printer and restarts the Connector to clear it.
const locks = new WeakMap<PrinterBinding, PhrozenOperationLock>()

/** Connects and refuses any printer that is not the provisioned one. */
export async function openPhrozenSession(
  binding: PrinterBinding,
  options: { signal: AbortSignal; timeoutMs?: number },
) {
  const local = readPhrozenPrinterBinding(binding)
  if (!local) throw new Error('Phrozen binding unavailable')
  const origin = new URL(local.origin)
  let lock = locks.get(binding)
  if (!lock) locks.set(binding, (lock = { busy: false, held: false }))
  const adapter = await connectPhrozen(origin.hostname, {
    udpPort: local.discoveryPort,
    wsPort: Number(origin.port || 80),
    timeoutMs: options.timeoutMs ?? 2500,
    // Inside the dispatcher's result window.
    confirmTimeoutMs: 4000,
    pollMs: 200,
    signal: options.signal,
    lock,
  })
  const { id, board, model, firmware } = adapter.identity
  const expected = local.expect
  if (
    id !== expected.id ||
    board !== expected.board ||
    model !== expected.model ||
    firmware !== expected.firmware
  )
    throw new Error('Phrozen identity mismatch')
  return adapter
}
