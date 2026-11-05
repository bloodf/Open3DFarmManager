#!/usr/bin/env node
import { projectVersion } from '@open3dfarmmanager/shared'
import { parseArgs } from 'node:util'
import { loadExistingIdentity, loadOrCreateIdentity } from './identity/store.ts'

const help = `Open3DFarmManager Connector

Uso:
  --version                         Exibir versão
  --help                            Exibir ajuda
  identity --data-dir <diretório>    Consultar identidade existente (JSON público)
  init-identity --data-dir <dir>     Criar ou reutilizar identidade local (JSON público)
  run --config <arquivo> --credential-file <segredo> --data-dir <dir>
                                    Coletar e enviar telemetria autenticada
  collect --config <arquivo> --data-dir <dir>
                                    Coletar telemetria local somente para leitura

A consulta não cria uma identidade. O comando collect grava apenas localmente. O comando run exige uma identidade e uma credencial existentes para enviar telemetria autenticada. Nenhum dos dois faz pareamento.`

export function main(args: string[]): number {
  let parsed: ReturnType<
    typeof parseArgs<{
      options: {
        version: { type: 'boolean' }
        help: { type: 'boolean' }
        'data-dir': { type: 'string' }
      }
      allowPositionals: true
    }>
  >
  try {
    parsed = parseArgs({
      args,
      options: {
        version: { type: 'boolean' },
        help: { type: 'boolean' },
        'data-dir': { type: 'string' },
      },
      allowPositionals: true,
    })
  } catch {
    console.error('Argumentos inválidos. Use --help.')
    return 1
  }
  const { values, positionals } = parsed
  if (values.help || args.length === 0) {
    console.log(help)
    return 0
  }
  if (values.version && positionals.length === 0 && !values['data-dir']) {
    console.log(projectVersion)
    return 0
  }
  if (
    positionals.length !== 1 ||
    !['identity', 'init-identity'].includes(positionals[0]!) ||
    !values['data-dir'] ||
    values.version
  ) {
    console.error('Argumentos inválidos. Use --help.')
    return 1
  }
  try {
    const identity =
      positionals[0] === 'init-identity'
        ? loadOrCreateIdentity(values['data-dir'])
        : loadExistingIdentity(values['data-dir'])
    console.log(JSON.stringify(identity))
    return 0
  } catch {
    // No paths, key contents or underlying crypto/parser errors in terminal output.
    console.error(
      positionals[0] === 'init-identity'
        ? 'Não foi possível inicializar a identidade. Verifique o diretório e as permissões; arquivos de recuperação exigem revisão antes de uma nova tentativa.'
        : 'Não foi possível consultar a identidade. Verifique o diretório, as permissões e os arquivos de recuperação; nenhum arquivo foi alterado.',
    )
    return 1
  }
}
async function dispatch(args: string[]): Promise<number> {
  if (args[0] !== 'collect' && args[0] !== 'run') return main(args)
  const running = args[0] === 'run'
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  try {
    const { values, positionals } = parseArgs({
      args: args.slice(1),
      options: {
        config: { type: 'string' },
        'data-dir': { type: 'string' },
        'credential-file': { type: 'string' },
      },
      allowPositionals: false,
    })
    if (
      positionals.length ||
      !values.config ||
      !values['data-dir'] ||
      (running
        ? !values['credential-file']
        : values['credential-file'] !== undefined)
    ) {
      console.error('Argumentos inválidos. Use --help.')
      return 1
    }
    const common = {
      configPath: values.config,
      dataDirectory: values['data-dir'],
      signal: controller.signal,
      onDiagnostic(diagnostic: object) {
        console.log(JSON.stringify(diagnostic))
      },
    }
    if (running && values['credential-file']) {
      const { runConnectorAgent } = await import('./runtime/agent.ts')
      await runConnectorAgent({
        ...common,
        credentialPath: values['credential-file'],
      })
    } else {
      const { collectLocalTelemetry } = await import('./runtime/collect.ts')
      await collectLocalTelemetry(common)
    }
    return 0
  } catch {
    console.error(
      'Não foi possível manter a coleta local. Verifique a configuração privada, as permissões e o armazenamento. Arquivos de recuperação exigem revisão; nenhum bloqueio antigo foi removido.',
    )
    return 1
  } finally {
    controller.abort()
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}
if (import.meta.main) {
  void dispatch(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
