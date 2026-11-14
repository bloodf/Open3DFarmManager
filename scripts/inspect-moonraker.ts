import { pathToFileURL } from 'node:url'
import { readLocalCollectorConfig } from '../packages/connector/src/config/local.ts'
import { discoverMoonraker } from '../packages/connector/src/moonraker/discovery.ts'
import { MoonrakerClientError } from '../packages/connector/src/moonraker/client.ts'

const usage =
  'Uso: node scripts/inspect-moonraker.ts --config <arquivo> --printer <chave>\n'

export async function main(args: string[]): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write(usage)
    return 0
  }
  if (
    args.length !== 4 ||
    new Set([args[0], args[2]]).size !== 2 ||
    ![args[0], args[2]].includes('--config') ||
    ![args[0], args[2]].includes('--printer') ||
    !args[1] ||
    !args[3] ||
    args[1].startsWith('--') ||
    args[3].startsWith('--')
  ) {
    process.stderr.write(usage)
    return 2
  }
  const options = new Map([
    [args[0], args[1]],
    [args[2], args[3]],
  ])
  try {
    const config = readLocalCollectorConfig(options.get('--config')!)
    const printer = config.printers.find(
      (item) => item.printerKey === options.get('--printer'),
    )
    if (!printer) {
      process.stderr.write('Impressora não encontrada na configuração.\n')
      return 2
    }
    const result = await discoverMoonraker({
      origin: printer.origin,
      apiKeyFile: printer.apiKeyFile,
      limits: config.limits,
      signal: new AbortController().signal,
      client: {
        name: 'Open3DFarmManager inspect',
        version: '1',
        url: 'https://github.com/bloodf/Open3dFarmManager',
      },
    })
    const version = result.server.moonrakerVersion
    process.stdout.write(
      JSON.stringify({
        model: null,
        firmware: null,
        moonrakerVersion:
          version && /^[\w.+-]{1,128}$/.test(version) ? version : null,
        readiness: result.server.ready ? 'ready' : 'unknown',
        tools: result.tools.tools.map(
          ({ index, object, active, celsius, targetCelsius }) => ({
            index,
            object,
            active,
            celsius,
            targetCelsius,
          }),
        ),
      }) + '\n',
    )
    return 0
  } catch (error) {
    if (error instanceof MoonrakerClientError && error.reason === 'not-ready') {
      process.stdout.write(
        JSON.stringify({
          model: null,
          firmware: null,
          moonrakerVersion: null,
          readiness: 'not-ready',
          tools: null,
        }) + '\n',
      )
      return 1
    }
    process.stderr.write(
      'Não foi possível inspecionar a impressora. Verifique a configuração e a conexão.\n',
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
