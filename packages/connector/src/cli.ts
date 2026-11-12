#!/usr/bin/env node
import { projectVersion } from '@open3dfarmmanager/shared'
import { parseStatusPort } from './status/local.ts'
import { parseArgs } from 'node:util'
import { loadExistingIdentity, loadOrCreateIdentity } from './identity/store.ts'
import { PairingProofOrigin } from '../../farm-protocol/src/pairing-proof.ts'
import {
  PairingProofExpired,
  pairConnector,
  readCredentialStatus,
} from './cloud/pairing-client.ts'

const help = `Open3DFarmManager Connector

Uso:
  --version                         Exibir versão
  --help                            Exibir ajuda
  identity --data-dir <diretório>    Consultar identidade existente (JSON público)
  init-identity --data-dir <dir>     Criar ou reutilizar identidade local (JSON público)
  run --config <arquivo> --credential-file <segredo> --data-dir <dir>
                                    Coletar e enviar telemetria autenticada
  run ... --status-port <porta>    Habilitar página local em 127.0.0.1
  pair --server <origem> --audience <audiência> --data-dir <dir> --credential-file <arquivo>
                                    Parear com o servidor: exibe código e impressão digital para confirmar no navegador
  status --data-dir <dir> [--credential-file <arquivo>]
                                    Estado local (JSON): impressão digital e validade da credencial; sem segredos
  collect --config <arquivo> --data-dir <dir>
                                    Coletar telemetria local somente para leitura

A consulta não cria uma identidade. O comando collect grava apenas localmente. O comando run exige uma identidade e uma credencial existentes para enviar telemetria autenticada. Somente o comando pair faz pareamento; ele exige uma identidade existente, aprovação no navegador em até 60 segundos após a exibição do código e nunca sobrescreve uma credencial existente.`

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
async function pair(args: string[]): Promise<number> {
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  try {
    const { values, positionals } = parseArgs({
      args,
      options: {
        server: { type: 'string' },
        audience: { type: 'string' },
        'data-dir': { type: 'string' },
        'credential-file': { type: 'string' },
      },
      allowPositionals: true,
    })
    if (
      positionals.length ||
      !values.server ||
      !values.audience ||
      !values['data-dir'] ||
      !values['credential-file']
    ) {
      console.error('Argumentos inválidos. Use --help.')
      return 1
    }
    const result = await pairConnector({
      serverOrigin: PairingProofOrigin.parse(values.server.replace(/\/$/, '')),
      audience: values.audience,
      identity: loadExistingIdentity(values['data-dir']),
      credentialPath: values['credential-file'],
      signal: controller.signal,
      onCode({ userCode, fingerprint }) {
        console.log(
          `Confirme no navegador (em até 60 segundos):\n  Código: ${userCode}\n  Impressão digital: ${fingerprint}\nA impressão digital exibida no navegador deve ser idêntica.`,
        )
      },
    })
    console.log(
      `Pareamento concluído. Credencial válida até ${new Date(result.expiresAt).toISOString()}.`,
    )
    return 0
  } catch (error) {
    // No tokens, device codes, paths or server bodies in terminal output.
    if (error instanceof PairingProofExpired) {
      console.error(
        'A prova expirou antes da aprovação. Inicie um novo pareamento e aprove em até 60 segundos após a exibição do código.',
      )
      return 1
    }
    console.error(
      'Não foi possível concluir o pareamento. Verifique o servidor, a audiência, a identidade, se a credencial já existe e a aprovação no navegador; inicie um novo pareamento.',
    )
    return 1
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}
function status(args: string[]): number {
  try {
    const { values, positionals } = parseArgs({
      args,
      options: {
        'data-dir': { type: 'string' },
        'credential-file': { type: 'string' },
      },
      allowPositionals: true,
    })
    if (positionals.length || !values['data-dir']) {
      console.error('Argumentos inválidos. Use --help.')
      return 1
    }
    const identity = loadExistingIdentity(values['data-dir'])
    const credentialFile = values['credential-file']
    console.log(
      JSON.stringify({
        fingerprint: identity.fingerprint,
        credential:
          credentialFile === undefined
            ? null
            : readCredentialStatus(
                credentialFile,
                identity.fingerprint,
                Date.now(),
              ),
      }),
    )
    return 0
  } catch {
    console.error(
      'Não foi possível consultar o estado local. Verifique o diretório e as permissões.',
    )
    return 1
  }
}
async function dispatch(args: string[]): Promise<number> {
  if (args[0] === 'pair') return pair(args.slice(1))
  if (args[0] === 'status') return status(args.slice(1))
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
        'status-port': { type: 'string' },
      },
      allowPositionals: false,
    })
    if (
      positionals.length ||
      (!running && values['status-port'] !== undefined) ||
      !values.config ||
      !values['data-dir'] ||
      (running
        ? !values['credential-file']
        : values['credential-file'] !== undefined)
    ) {
      console.error('Argumentos inválidos. Use --help.')
      return 1
    }
    const statusPort =
      values['status-port'] === undefined
        ? undefined
        : parseStatusPort(values['status-port'])
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
        ...(statusPort === undefined ? {} : { statusPort }),
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
