#!/usr/bin/env node
import { projectVersion } from '@open3dfarmmanager/shared'
import { parseArgs } from 'node:util'
import { loadExistingIdentity } from './identity/store.ts'

const help = `Open3DFarmManager Connector

Uso:
  --version                         Exibir versão
  --help                            Exibir ajuda
  identity --data-dir <diretório>    Consultar identidade existente (JSON público)

A consulta não cria uma identidade. Pareamento e conexão com impressoras ainda não estão disponíveis.`

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
    positionals[0] !== 'identity' ||
    !values['data-dir'] ||
    values.version
  ) {
    console.error('Argumentos inválidos. Use --help.')
    return 1
  }
  try {
    console.log(JSON.stringify(loadExistingIdentity(values['data-dir'])))
    return 0
  } catch {
    // No paths, key contents or underlying crypto/parser errors in terminal output.
    console.error(
      'Não foi possível consultar a identidade. Verifique o diretório, as permissões e os arquivos de recuperação; nenhum arquivo foi alterado.',
    )
    return 1
  }
}
if (import.meta.main) process.exitCode = main(process.argv.slice(2))
