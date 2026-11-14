import { readLocalCollectorConfig } from '../packages/connector/src/config/local.ts'
import { readProvisioningConfig } from '../packages/connector/src/config/provisioning.ts'
import { readAgentRuntimeConfig } from '../packages/connector/src/config/runtime.ts'

const args = process.argv.slice(2)
if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
  process.stdout.write(
    'Uso: node scripts/check-connector-config.ts <local|provisioning|runtime> <arquivo> [farm_id agent_id]\n',
  )
} else {
  const [kind, path, farm_id, agent_id] = args
  if (
    !path ||
    !(
      ((kind === 'local' || kind === 'provisioning') && args.length === 2) ||
      (kind === 'runtime' && args.length === 4 && farm_id && agent_id)
    )
  ) {
    process.stderr.write('Falha: argumentos inválidos. Use --help.\n')
    process.exitCode = 1
  } else {
    try {
      let count: number
      if (kind === 'local') {
        const config = readLocalCollectorConfig(path)
        count =
          config.printers.length +
          (config.version === 2 ? config.kobralink.printers.length : 0)
      } else if (kind === 'provisioning') {
        readProvisioningConfig(path)
        count = 0
      } else {
        count = readAgentRuntimeConfig(path, {
          farm_id: farm_id!,
          agent_id: agent_id!,
        }).assignments.length
      }
      process.stdout.write(`Configuração: ${kind}; impressoras: ${count}\n`)
    } catch {
      process.stderr.write('Falha: configuração inválida ou inacessível.\n')
      process.exitCode = 1
    }
  }
}
