// SPDX-License-Identifier: MIT
import { pathToFileURL } from 'node:url'
import { qualifyPrinter } from './qualify/qualify.ts'
import type { QualifyCliOptions } from './qualify/types.ts'

const USAGE = `Usage: node scripts/qualify-printer.ts --vendor <v> --host <h> [credential file] [options]

Arguments:
  --vendor, -v <vendor>          Printer vendor (moonraker, bambu, creality, anycubic, kobralink) [required]
  --host, -h <host>              Printer IP or hostname [required]
  [credential file]              Optional path to credentials JSON or token file

Options:
  --port <port>                  Target network port (defaults by vendor: moonraker=7125, bambu=8883, creality=9999, anycubic=9883)
  --serial <serial>              Printer serial number (Bambu, Anycubic)
  --timeout <ms>                 Timeout in milliseconds (default: 10000)
  --camera-port <port>           Explicit camera port override
  --ftps-port <port>             Bambu FTPS listing port override (default: 990)
  --ca-file <path>               TLS CA certificate path
  --pin-sha256 <hex>             TLS certificate SHA-256 pin
  --webcam-origin <origin>       Moonraker webcam origin override
  --help                         Show this help message

Security Guarantee:
  This tool performs strictly read-only qualification checks (identity, telemetry observation,
  camera reachability, file listing). It never transmits commands, gcode, or state-changing
  requests to physical printers. Any flags attempting actuator movement or command execution
  are strictly refused.
`

// Forbidden command and actuator flags that must be rejected to guarantee read-only execution
const FORBIDDEN_COMMAND_FLAGS = [
  '--command',
  '--send',
  '--pause',
  '--resume',
  '--stop',
  '--cancel',
  '--execute',
  '--gcode',
  '--print',
  '--move',
  '--extrude',
  '--set-temp',
  '--home',
  '--fan',
  '--light',
  '--delete',
]

export function parseCliArgs(args: string[]): {
  options?: QualifyCliOptions | undefined
  error?: string | undefined
  help?: boolean | undefined
} {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    return { help: true }
  }

  // Refuse any forbidden command flags immediately
  for (const arg of args) {
    const flagName = arg.split('=')[0]?.toLowerCase() ?? ''
    if (FORBIDDEN_COMMAND_FLAGS.includes(flagName)) {
      return {
        error: `Safety violation: Command execution flag '${flagName}' is forbidden. This tool is strictly read-only.`,
      }
    }
  }

  let vendor: string | undefined
  let host: string | undefined
  let port: number | undefined
  let credentialFile: string | undefined
  let serial: string | undefined
  let timeoutMs: number | undefined
  let cameraPort: number | undefined
  let ftpsPort: number | undefined
  let caFile: string | undefined
  let pinSha256: string | undefined
  let webcamOrigin: string | undefined

  let i = 0
  while (i < args.length) {
    const arg = args[i]!
    if (arg === '--vendor' || arg === '-v') {
      if (i + 1 >= args.length) return { error: 'Missing value for --vendor' }
      vendor = args[++i]
    } else if (arg === '--host' || arg === '-h') {
      if (i + 1 >= args.length) return { error: 'Missing value for --host' }
      host = args[++i]
    } else if (arg === '--port') {
      if (i + 1 >= args.length) return { error: 'Missing value for --port' }
      const p = Number(args[++i])
      if (!Number.isInteger(p) || p < 1 || p > 65535)
        return { error: 'Invalid port number' }
      port = p
    } else if (
      arg === '--credential-file' ||
      arg === '--credentials' ||
      arg === '--credential'
    ) {
      if (i + 1 >= args.length)
        return { error: 'Missing value for --credential-file' }
      credentialFile = args[++i]
    } else if (arg === '--serial') {
      if (i + 1 >= args.length) return { error: 'Missing value for --serial' }
      serial = args[++i]
    } else if (arg === '--timeout') {
      if (i + 1 >= args.length) return { error: 'Missing value for --timeout' }
      const t = Number(args[++i])
      if (!Number.isFinite(t) || t < 100) return { error: 'Invalid timeout' }
      timeoutMs = t
    } else if (arg === '--camera-port') {
      if (i + 1 >= args.length)
        return { error: 'Missing value for --camera-port' }
      const cp = Number(args[++i])
      if (!Number.isInteger(cp) || cp < 1 || cp > 65535)
        return { error: 'Invalid camera port' }
      cameraPort = cp
    } else if (arg === '--ftps-port') {
      if (i + 1 >= args.length)
        return { error: 'Missing value for --ftps-port' }
      const fp = Number(args[++i])
      if (!Number.isInteger(fp) || fp < 1 || fp > 65535)
        return { error: 'Invalid FTPS port' }
      ftpsPort = fp
    } else if (arg === '--ca-file') {
      if (i + 1 >= args.length) return { error: 'Missing value for --ca-file' }
      caFile = args[++i]
    } else if (arg === '--pin-sha256') {
      if (i + 1 >= args.length)
        return { error: 'Missing value for --pin-sha256' }
      pinSha256 = args[++i]
    } else if (arg === '--webcam-origin') {
      if (i + 1 >= args.length)
        return { error: 'Missing value for --webcam-origin' }
      webcamOrigin = args[++i]
    } else if (!arg.startsWith('-') && !credentialFile) {
      // Positional argument for credential file
      credentialFile = arg
    } else {
      return { error: `Unknown or unexpected argument '${arg}'` }
    }
    i++
  }

  if (!vendor || !host) {
    return {
      error:
        'Missing required parameters: --vendor <vendor> and --host <host> must be specified.',
    }
  }

  return {
    options: {
      vendor,
      host,
      ...(port !== undefined ? { port } : {}),
      ...(credentialFile !== undefined ? { credentialFile } : {}),
      ...(serial !== undefined ? { serial } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(cameraPort !== undefined ? { cameraPort } : {}),
      ...(ftpsPort !== undefined ? { ftpsPort } : {}),
      ...(caFile !== undefined ? { caFile } : {}),
      ...(pinSha256 !== undefined ? { pinSha256 } : {}),
      ...(webcamOrigin !== undefined ? { webcamOrigin } : {}),
    },
  }
}

export async function main(args: string[]): Promise<number> {
  const parsed = parseCliArgs(args)

  if (parsed.help) {
    process.stdout.write(USAGE + '\n')
    return 0
  }

  if (parsed.error || !parsed.options) {
    process.stderr.write(
      `Error: ${parsed.error ?? 'Invalid arguments'}\n\n${USAGE}\n`,
    )
    return 2
  }

  try {
    const report = await qualifyPrinter(parsed.options)
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    return 0
  } catch (error) {
    process.stderr.write(
      `Printer qualification failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
    )
    return 1
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main(process.argv.slice(2))
}
