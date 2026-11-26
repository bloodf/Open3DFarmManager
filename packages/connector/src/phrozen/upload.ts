/**
 * Browser file transfer to a Phrozen printer's local storage. The wire upload,
 * its preconditions (capability, listed file type, idle printer, no overwrite)
 * and its confirmation are the adapter's (operations.ts).
 */
import { readFile, stat } from 'node:fs/promises'
import {
  readPhrozenPrinterBinding,
  type PrinterBinding,
} from '../control/printer-binding.ts'
import { DriverRefusalError } from '../control/driver-refusal.ts'
import {
  phrozenWriteQualified,
  type PhrozenQualification,
} from './qualification.ts'
import { openPhrozenSession } from './session.ts'

// The file is held in memory for the adapter's whole-file MD5.
const MAX_FILE_BYTES = 512 * 1024 * 1024

type Target = {
  binding: PrinterBinding
  qualifiedWrites?: readonly PhrozenQualification[] | undefined
}

/** Whether this printer offers a transfer of that name at all. */
export function supportsPhrozenUpload(target: Target, name: string): boolean {
  const local = readPhrozenPrinterBinding(target.binding)
  return (
    !!local &&
    phrozenWriteQualified(
      local.expect.model,
      local.expect.firmware,
      target.qualifiedWrites,
    ) &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,123}\.(ctb|prz)$/i.test(name) &&
    !name.includes('..')
  )
}

export async function uploadPhrozenFile(
  input: Target & {
    filePath: string
    name: string
    signal: AbortSignal
    /** Rechecked before the identity probe and before every packet. */
    authorized(): boolean
  },
): Promise<void> {
  // The messages are the transfer result reasons of runtime/file-upload.ts.
  if (!supportsPhrozenUpload(input, input.name))
    throw new DriverRefusalError('unsupported-action', 'unsupported')
  const permitted = () => !input.signal.aborted && input.authorized()
  if (!permitted()) throw new DriverRefusalError('state', 'unauthorized')
  const { size } = await stat(input.filePath)
  if (!size || size > MAX_FILE_BYTES)
    throw new DriverRefusalError('invalid-command', 'invalid-transfer')
  const bytes = await readFile(input.filePath, { signal: input.signal })
  const adapter = await openPhrozenSession(input.binding, {
    signal: input.signal,
  }).catch((cause: unknown) => {
    throw new DriverRefusalError('state', 'offline', { cause })
  })
  let started = false
  const result = await adapter.upload(input.name, bytes, () => {
    const allowed = permitted()
    started ||= allowed
    return allowed
  })
  if (result.outcome === 'confirmed') return
  const detail = new Error(`Phrozen upload ${result.reason}`)
  // Before the first packet the printer received nothing.
  if (!started)
    throw new DriverRefusalError(
      'state',
      result.reason === 'not-permitted'
        ? 'unauthorized'
        : result.reason === 'printer-not-idle' ||
            result.reason === 'operation-in-progress'
          ? 'busy'
          : result.reason === 'file-type-not-reported' ||
              result.reason === 'capability-not-reported'
            ? 'unsupported'
            : 'offline',
      { cause: detail },
    )
  throw detail
}
