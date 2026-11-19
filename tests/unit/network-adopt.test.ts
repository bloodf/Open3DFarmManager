import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { buildSync } from 'esbuild'
import { expect, test, vi } from 'vitest'
import { compileScript, parse } from 'vue/compiler-sfc'
import {
  adoptionPrinter,
  mergeNetworkDiscoveries,
} from '../../apps/farm/app/utils/network-adoption.ts'
import { buildEntries } from '../../apps/farm/app/utils/network-map.ts'
import { createPrinterDiscovery } from '../../apps/farm/app/utils/printer-setup-discovery.ts'
import { createPrinterSetupState } from '../../apps/farm/app/utils/printer-setup-state.ts'

const found = {
  agentId: 'connector-a',
  vendor: 'moonraker',
  host: '127.0.0.1',
  port: 7125,
  name: 'Mock Moonraker',
  adopted: false,
  lastSeen: 10,
}

test('renders an accessible adoption action and prefills the existing setup fields', async () => {
  const filename = resolve(
    'apps/farm/app/components/network/AdoptDiscoveredPrinter.vue',
  )
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
  const script = compileScript(descriptor, {
    id: 'adoption',
    inlineTemplate: true,
  })
  const bundle = buildSync({
    stdin: {
      contents: `
        import { createSSRApp } from 'vue'
        import { renderToString } from 'vue/server-renderer'
        ${script.content.replace('export default', 'const Component =')}
        export const render = (found) => renderToString(createSSRApp(Component, { found }))
      `,
      resolveDir: resolve(filename, '..'),
      loader: 'ts',
    },
    external: ['vue', 'vue/server-renderer'],
    bundle: true,
    platform: 'node',
    write: false,
  })
  const module = {
    exports: {} as { render: (item: typeof found) => Promise<string> },
  }
  new Function('require', 'module', 'exports', bundle.outputFiles[0]!.text)(
    createRequire(import.meta.url),
    module,
    module.exports,
  )
  expect(await module.exports.render(found)).toContain(
    'Adicionar à farm: Mock Moonraker',
  )
  expect(
    await module.exports.render({ ...found, adopted: true }),
  ).not.toContain('<button')
  expect(await module.exports.render({ ...found, host: '' })).not.toContain(
    '<button',
  )

  const state = createPrinterSetupState()
  state.kobraAgentId.value = found.agentId
  state.moonrakerApiKey.value = 'old-key'
  const discovery = createPrinterDiscovery(
    state,
    () => undefined,
    vi.fn(),
    vi.fn(),
  )
  discovery.selectDiscovery(adoptionPrinter(found)!)
  expect(state.kobraAgentId.value).toBe('connector-a')
  expect(state.onboardingFamily.value).toBe('klipper-moonraker')
  expect(state.moonrakerOrigin.value).toBe('http://127.0.0.1:7125')
  expect(state.kobraLabel.value).toBe('Mock Moonraker')
  expect(state.moonrakerApiKey.value).toBe('')
})

test('merges a scan by Connector and keeps a reported adoption bound', () => {
  const newer = { ...found, name: 'Atualizada', lastSeen: 20 }
  const other = { ...newer, agentId: 'connector-b' }
  expect(mergeNetworkDiscoveries([found], [newer, other, newer])).toEqual([
    newer,
    other,
  ])

  const adopted = { ...found, adopted: true, lastSeen: 15 }
  const discoveries = mergeNetworkDiscoveries([adopted], [newer])
  expect(discoveries).toEqual([adopted])
  const entries = buildEntries(
    {
      connectors: [
        {
          agentId: found.agentId,
          fingerprint: 'test',
          status: 'approved',
          lastSeenAt: 15,
          health: null,
        },
      ],
      printers: [
        {
          assignmentId: 'assignment-a',
          agentId: found.agentId,
          printerKey: 'printer-a',
          displayName: found.name,
          link: null,
        },
      ],
      discovered: discoveries,
    },
    { now: 20 },
  )
  expect(entries.map(({ kind, href }) => ({ kind, href }))).toEqual([
    { kind: 'connector', href: null },
    { kind: 'printer', href: '/impressoras/printer-a' },
  ])
})
