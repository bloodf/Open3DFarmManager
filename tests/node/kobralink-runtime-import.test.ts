import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const file = (path: string) => fileURLToPath(new URL(path, import.meta.url))
const runtimePath = file('../../packages/connector/src/kobralink/runtime.ts')
const runtime = pathToFileURL(runtimePath).href
const local = pathToFileURL(
  file('../../packages/connector/src/config/local.ts'),
).href
const configuration = pathToFileURL(
  file('../../packages/connector/src/kobralink/configuration.ts'),
).href

/** Every case needs an empty module cache, so each runs in its own Node. */
function node(args: readonly string[]) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
  })
  assert.equal(
    result.status,
    0,
    `fresh Node exited ${result.status} (${result.signal})\n${result.stderr}`,
  )
  return result.stdout
}

// Evaluates in the child after both modules loaded in the requested order.
const probe = `
const binding = {
  backend: 'kobralink',
  version: 2,
  bridgeInstance: 'owned-bridge',
  origin: 'http://127.0.0.1:8080',
  deviceId: 'device-1',
  id: 'printer_1',
  printerKey: 'kobra-x',
  revision: 1,
  credentialFile: '/nonexistent/credential.json',
}
const shared = (await import(${JSON.stringify(configuration)}))
  .KobraLinkRuntimeBinding
const legacy = {
  version: 1,
  allowedOrigins: ['http://127.0.0.1:7125'],
  printers: [{ printerKey: 'voron', origin: 'http://127.0.0.1:7125' }],
}
const mixed = {
  ...legacy,
  version: 2,
  kobralink: { allowedOrigins: [binding.origin], printers: [binding] },
}
const parsed = localModule.LocalCollectorConfigSchema.parse(mixed)
process.stdout.write(JSON.stringify({
  sameSchema: runtimeModule.KobraLinkRuntimeBinding === shared,
  runtimeExports: [
    typeof runtimeModule.createKobraLinkRuntimeSubscription,
    typeof runtimeModule.readKobraLinkCredential,
  ],
  localExports: [
    typeof localModule.readPrivateJsonFile,
    typeof localModule.parseLocalCollectorConfig,
    typeof localModule.readLocalCollectorConfig,
  ],
  binding: runtimeModule.KobraLinkRuntimeBinding.parse(binding),
  kobralinkPrinters: parsed.kobralink.printers,
  legacyVersion: localModule.LocalCollectorConfigSchema.parse(legacy).version,
  rejectsUnknownKey: !runtimeModule.KobraLinkRuntimeBinding.safeParse({
    ...binding, extra: true,
  }).success,
  rejectsBadId: !localModule.LocalCollectorConfigSchema.safeParse({
    ...mixed,
    kobralink: {
      ...mixed.kobralink, printers: [{ ...binding, id: 'bad id' }],
    },
  }).success,
  rejectsEmptyKobralink: !localModule.LocalCollectorConfigSchema.safeParse({
    ...mixed, kobralink: { ...mixed.kobralink, printers: [] },
  }).success,
}))
`

function importInOrder(first: 'runtime' | 'local') {
  const load = {
    runtime: `const runtimeModule = await import(${JSON.stringify(runtime)})`,
    local: `const localModule = await import(${JSON.stringify(local)})`,
  }
  const order =
    first === 'runtime'
      ? [load.runtime, load.local]
      : [load.local, load.runtime]
  const result = JSON.parse(
    node(['--input-type=module', '-e', `${order.join('\n')}\n${probe}`]),
  )
  assert.equal(result.sameSchema, true)
  assert.deepEqual(result.runtimeExports, ['function', 'function'])
  assert.deepEqual(result.localExports, ['function', 'function', 'function'])
  assert.equal(result.binding.printerKey, 'kobra-x')
  assert.deepEqual(result.kobralinkPrinters, [result.binding])
  assert.equal(result.legacyVersion, 1)
  assert.equal(result.rejectsUnknownKey, true)
  assert.equal(result.rejectsBadId, true)
  assert.equal(result.rejectsEmptyKobralink, true)
}

test('fresh process imports the KobraLink runtime before local config', () => {
  importInOrder('runtime')
})

test('fresh process imports local config before the KobraLink runtime', () => {
  importInOrder('local')
})

test('KobraLink runtime loads as a direct Node entry point', () => {
  assert.equal(node([runtimePath]), '')
})

test('local config still enforces the bound KobraLink credential', () => {
  const output = node([
    '--input-type=module',
    '-e',
    `
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { readKobraLinkCredential } = await import(${JSON.stringify(runtime)})
const { parseLocalCollectorConfig } = await import(${JSON.stringify(local)})
const dir = mkdtempSync(join(tmpdir(), 'kobralink-import-'))
try {
  const credentialFile = join(dir, 'credential.json')
  const context = {
    bridgeInstance: 'owned-bridge',
    origin: 'http://127.0.0.1:8080',
    deviceId: 'device-1',
    id: 'printer_1',
    printerKey: 'kobra-x',
    revision: 1,
  }
  const binding = { backend: 'kobralink', version: 2, ...context, credentialFile }
  const config = {
    version: 2,
    allowedOrigins: [],
    printers: [],
    kobralink: { allowedOrigins: [context.origin], printers: [binding] },
  }
  const write = (revision) =>
    writeFileSync(
      credentialFile,
      JSON.stringify({
        version: 1,
        ...context,
        revision,
        name: 'Synthetic Owner',
        email: 'owner@example.invalid',
        password: 'synthetic-password',
      }),
      { mode: 0o600 },
    )
  const message = (run) => {
    try {
      run()
      return null
    } catch (error) {
      return error.message
    }
  }
  write(1)
  const accepted = parseLocalCollectorConfig(config).kobralink.printers.length
  const name = readKobraLinkCredential(binding).name
  write(2)
  process.stdout.write(JSON.stringify({
    accepted,
    name,
    local: message(() => parseLocalCollectorConfig(config)),
    runtime: message(() => readKobraLinkCredential(binding)),
  }))
} finally {
  rmSync(dir, { recursive: true, force: true })
}
`,
  ])
  assert.deepEqual(JSON.parse(output), {
    accepted: 1,
    name: 'Synthetic Owner',
    local: 'KobraLink credential context mismatch',
    runtime: 'KobraLink credential context mismatch',
  })
})
