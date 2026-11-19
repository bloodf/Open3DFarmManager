import { pathToFileURL } from 'node:url'
import { probePrinterHost } from '../packages/connector/src/discovery/probe.ts'
import { discoverPrinters } from '../packages/connector/src/discovery/index.ts'

const usage =
  'Uso: node scripts/discover-printers.ts [--timeout <ms> | --probe <host>]\n'
export async function main(
  args: string[],
  discover: typeof discoverPrinters = discoverPrinters,
  probe: typeof probePrinterHost = probePrinterHost,
): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    process.stdout.write(usage)
    return 0
  }
  if (
    args.length &&
    (args.length !== 2 ||
      !(
        (args[0] === '--timeout' && /^\d+$/.test(args[1]!)) ||
        (args[0] === '--probe' && args[1])
      ))
  ) {
    process.stderr.write(usage)
    return 2
  }
  try {
    const printers =
      args[0] === '--probe'
        ? ((await probe(args[1]!)) ?? null)
        : await discover({
            timeout: args.length ? Number(args[1]) : 3000,
          })
    process.stdout.write(JSON.stringify(printers) + '\n')
    return 0
  } catch (error) {
    process.stderr.write(
      `Falha na descoberta: ${error instanceof Error ? error.message : 'erro desconhecido'}\n`,
    )
    return 1
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main(process.argv.slice(2))
