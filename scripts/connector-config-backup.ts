import { constants, lstatSync, openSync, fstatSync, readSync, closeSync, mkdtempSync, writeFileSync, chmodSync, linkSync, rmSync, realpathSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPrivateJsonFile, parseLocalCollectorConfig } from '../packages/connector/src/config/local.ts'
import { parseProvisioningConfig } from '../packages/connector/src/config/provisioning.ts'

export function copyConnectorConfig(source: string, target: string, kind: 'collector' | 'provisioning'): void {
  for (const path of [source, target]) {
    if (path.split(/[\\/]/).includes('..')) throw Error('Caminho com travessia recusado')
    const absolute = resolve(path)
    let parent = dirname(absolute)
    while (true) {
      const stat = lstatSync(parent)
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error('Diretório inválido')
      if (parent === dirname(parent)) break
      parent = dirname(parent)
    }
  }
  const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let bytes: Buffer
  let mode: number
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 65536) throw Error('Arquivo privado inválido')
    mode = stat.mode & 0o700
    const buffer = Buffer.alloc(65537)
    let size = 0
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null)
      if (!count) break
      size += count
    }
    if (size > 65536) throw Error('Arquivo grande demais')
    bytes = buffer.subarray(0, size)
  } finally { closeSync(fd) }
  const directory = mkdtempSync(join(realpathSync(dirname(resolve(target))), '.connector-copy-'))
  const staged = join(directory, 'config')
  try {
    writeFileSync(staged, bytes, { mode: 0o600, flag: 'wx' })
    const input = readPrivateJsonFile(staged, { maxBytes: kind === 'provisioning' ? 16384 : 65536, maxStringChars: kind === 'provisioning' ? 4096 : 2048 })
    if (kind === 'provisioning') parseProvisioningConfig(input)
    else {
      if (typeof input !== 'object' || input === null || !('version' in input) || input.version !== 1) throw Error('Somente coleta v1 é aceita')
      parseLocalCollectorConfig(input)
    }
    chmodSync(staged, mode)
    linkSync(staged, resolve(target))
  } finally { rmSync(directory, { recursive: true }) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [action, kind, source, target, ...extra] = process.argv.slice(2)
  if (action === '--help') process.stdout.write('Uso: node scripts/connector-config-backup.ts backup|restore collector|provisioning ORIGEM DESTINO\nCopia somente o arquivo selecionado. Coleta v1 e provisionamento são validados. Identidades, credenciais e arquivos referenciados permanecem gerenciados separadamente. O destino deve estar ausente; nunca substitui configuração ativa.\n')
  else {
    try {
      if (!['backup', 'restore'].includes(action ?? '') || (kind !== 'collector' && kind !== 'provisioning') || !source || !target || extra.length) throw Error('Argumentos inválidos; use --help')
      copyConnectorConfig(source, target, kind)
    } catch { process.stderr.write('Cópia recusada; confira os argumentos, permissões e configuração.\n'); process.exitCode = 1 }
  }
}
