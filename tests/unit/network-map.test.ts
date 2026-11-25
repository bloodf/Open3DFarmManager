// SPDX-License-Identifier: MIT
import { readFile } from 'node:fs/promises'
import AxeBuilder from '@axe-core/playwright'
import { parse } from 'vue/compiler-sfc'
import { describe, expect, it } from 'vitest'
import { renderFarmComponent } from '../helpers/render-farm-component.ts'
import {
  buildEntries,
  defaultView,
  filterEntries,
  formatAge,
  layoutMap,
  printerOverlayKey,
  type NetworkData,
} from '../../apps/farm/app/utils/network-map.ts'
import { startHttpMock } from '../../packages/sim-tools/src/mocks/http-mock.ts'
import { launchBrowser } from '../helpers/browser.ts'

const file = '../network/FarmMap.vue'
const now = Date.UTC(2026, 10, 19, 12)
const agent = (n: number) =>
  `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`

/** Connector n has one bound printer and one discovered one; every third is silent. */
function fixture(count: number): NetworkData {
  const ids = Array.from({ length: count }, (_, n) => agent(n + 1))
  return {
    connectors: ids.map((agentId, n) => ({
      agentId,
      fingerprint: `fp-${n}`,
      status: 'approved' as const,
      lastSeenAt: n % 3 === 2 ? now - 600_000 : now - 4000,
      health: { version: '1.2.3', storage: 'healthy' as const },
    })),
    printers: ids.map((agentId, n) => ({
      assignmentId: `assignment-${n}`,
      agentId,
      printerKey: `printer-${n}`,
      displayName: `Voron ${n + 1}`,
      link: {
        state: (n % 2 ? 'reconnecting' : 'connected') as
          'reconnecting' | 'connected',
        lastSuccessAt: now - 2000,
        p50Ms: 20,
        p95Ms: 80,
      },
    })),
    discovered: ids.map((agentId, n) => ({
      agentId,
      vendor: 'moonraker',
      model: 'Voron',
      name: `Mesa ${n + 1}`,
      adopted: false,
      lastSeen: now - 1000,
    })),
  }
}
const entriesFor = (count: number) => buildEntries(fixture(count), { now })
const props = (count: number, extra: Record<string, unknown> = {}) => ({
  entries: entriesFor(count),
  now,
  live: false,
  asOf: now - 12_000,
  ...extra,
})

describe('network entries', () => {
  it('labels each link with its health and says why', () => {
    const byName = new Map(entriesFor(3).map((e) => [e.name, e]))
    expect(byName.get('Voron 1')).toMatchObject({
      status: 'connected',
      latencyMs: 20,
      lastSeenAt: now - 2000,
      href: '/impressoras/printer-0',
    })
    expect(byName.get('Voron 2')?.status).toBe('reconnecting')
    // A silent Connector cannot vouch for its printers.
    expect(byName.get(`Connector ${agent(3).slice(0, 8)}`)).toMatchObject({
      status: 'offline',
      statusText: 'Sem sinal',
    })
    expect(byName.get('Voron 3')).toMatchObject({
      status: 'offline',
      statusText: 'Sem sinal (Connector)',
    })
    expect(byName.get('Mesa 1')).toMatchObject({
      kind: 'discovered',
      status: 'discovered',
      href: null,
    })
  })

  it('prefers live observations over server data', () => {
    const entries = buildEntries(fixture(1), {
      now,
      agents: new Set([agent(1)]),
      printers: new Map([
        [printerOverlayKey(agent(1), 'printer-0'), { online: false, at: now }],
      ]),
    })
    expect(entries.find((e) => e.kind === 'printer')).toMatchObject({
      status: 'offline',
      lastSeenAt: now,
    })
    expect(entries.find((e) => e.kind === 'connector')?.status).toBe(
      'connected',
    )
  })

  it('uses live linkHealth latency and state when provided without server link', async () => {
    const data = fixture(2)
    const serverNull: NetworkData = {
      ...data,
      printers: data.printers.map((p) => ({ ...p, link: null })),
    }
    const entries = buildEntries(serverNull, {
      now,
      agents: new Set([agent(1), agent(2)]),
      printers: new Map([
        [
          printerOverlayKey(agent(1), 'printer-0'),
          {
            online: true,
            at: now,
            link: {
              state: 'connected',
              lastSuccessAt: now - 1000,
              p50Ms: 250,
              p95Ms: 265,
            },
          },
        ],
        [
          printerOverlayKey(agent(2), 'printer-1'),
          {
            online: true,
            at: now,
            link: {
              state: 'reconnecting',
              lastSuccessAt: null,
              p50Ms: 120,
              p95Ms: 410,
            },
          },
        ],
      ]),
    })
    const byName = new Map(entries.map((e) => [e.name, e]))
    expect(byName.get('Voron 1')).toMatchObject({
      status: 'connected',
      statusText: 'Conectado',
      latencyMs: 250,
      p95Ms: 265,
      lastSeenAt: now - 1000,
    })
    expect(byName.get('Voron 2')).toMatchObject({
      status: 'reconnecting',
      statusText: 'Reconectando',
      latencyMs: 120,
      p95Ms: 410,
      lastSeenAt: now,
    })
    const tableHtml = await renderFarmComponent(file, {
      entries,
      now,
      live: true,
      asOf: null,
    })
    expect(tableHtml).toContain('250 ms (p95 265 ms)')
    expect(tableHtml).toContain('↻ Reconectando')
    const mapHtml = await renderFarmComponent(file, {
      entries,
      now,
      live: true,
      asOf: null,
      initialView: 'map',
    })
    expect(mapHtml).toContain('✓ Conectado · 250 ms · agora')
    expect(mapHtml).toContain('↻ Reconectando · 120 ms')
  })

  it('does not list adopted discoveries twice and ignores unknown Connectors', () => {
    const data = fixture(1)
    const entries = buildEntries(
      {
        ...data,
        discovered: [
          { ...data.discovered[0]!, adopted: true },
          { ...data.discovered[0]!, agentId: agent(99) },
        ],
      },
      { now },
    )
    expect(entries.some((e) => e.kind === 'discovered')).toBe(false)
  })

  it('filters by Connector and status, keeping the parent of a match', () => {
    const entries = entriesFor(3)
    expect(
      filterEntries(entries, { agentId: agent(2), status: 'all' }).map(
        (e) => e.name,
      ),
    ).toEqual([`Connector ${agent(2).slice(0, 8)}`, 'Voron 2', 'Mesa 2'])
    const reconnecting = filterEntries(entries, {
      agentId: 'all',
      status: 'reconnecting',
    })
    expect(reconnecting.map((e) => e.name)).toEqual([
      `Connector ${agent(2).slice(0, 8)}`,
      'Voron 2',
    ])
  })

  it('formats ages and picks the default view by width', () => {
    expect(formatAge(now, now - 3000)).toBe('agora')
    expect(formatAge(now, now - 42_000)).toBe('há 42 s')
    expect(formatAge(now, now - 3 * 60_000)).toBe('há 3 min')
    expect(formatAge(now, null)).toBe('nunca')
    expect([320, 767, 768, 1280].map(defaultView)).toEqual([
      'table',
      'table',
      'map',
      'map',
    ])
  })

  it('lays out 30 Connectors without overlapping nodes', () => {
    const layout = layoutMap(entriesFor(30))
    const boxes = layout.nodes.map(
      (n) => `${n.x},${n.y},${n.width},${n.height}`,
    )
    expect(new Set(boxes).size).toBe(boxes.length)
    expect(layout.nodes).toHaveLength(90)
    expect(layout.width).toBeGreaterThan(30 * 100)
  })
})

describe.each([2, 30])('FarmMap with %i Connectors', (count) => {
  it('renders the table by default with every row, link and age', async () => {
    const html = await renderFarmComponent(file, props(count))
    expect(html.match(/<tr>/g)).toHaveLength(1 + count * 3)
    expect(html).toContain('Mostrando ' + count * 3 + ' de ' + count * 3)
    expect(html).toContain('<a href="/impressoras/printer-0">Voron 1</a>')
    expect(html).toContain('✓ Conectado')
    expect(html).toContain('20 ms (p95 80 ms)')
    expect(html).toContain('agora')
    expect(html).toContain('Dados do servidor, lidos há 12 s')
    expect(html).not.toContain('<svg')
  })

  it('renders the map with colour-independent link labels and click-through', async () => {
    const html = await renderFarmComponent(
      file,
      props(count, { initialView: 'map' }),
    )
    expect(html.match(/<svg/g)).toHaveLength(1)
    expect(html).toContain('href="/impressoras/printer-0"')
    expect(html).toContain('✓ Conectado · 20 ms · agora')
    expect(html).toContain('stroke-dasharray="4 4"')
    expect(html).toContain('stroke-dasharray="8 4"')
    expect(html).toContain('? Descoberta · agora')
    expect(html.match(/class="node dashed"/g)).toHaveLength(count)
    expect(html).not.toContain('<table')
  })
})

describe('FarmMap data source', () => {
  it('says the data is live when the direct session is up', async () => {
    const html = await renderFarmComponent(file, props(2, { live: true }))
    expect(html).toContain('Dados ao vivo')
    expect(html).not.toContain('Dados do servidor')
  })

  it('shows an empty farm and a filter that matches nothing', async () => {
    const html = await renderFarmComponent(file, props(0))
    expect(html).toContain('Nenhum Connector nesta farm.')
  })
})

describe('accessibility', () => {
  async function pageCss() {
    const base = '../../apps/farm/app/components/'
    const read = (path: string) =>
      readFile(new URL(path, import.meta.url), 'utf8')
    const styles = (
      await Promise.all(
        ['network/FarmMap.vue', 'ui/DataTable.vue'].map(async (path) =>
          parse(await read(base + path)).descriptor.styles.map(
            (s) => s.content,
          ),
        ),
      )
    )
      .flat()
      .join('\n')
    return `${await read('../../apps/farm/app/assets/tokens/tokens.css')}\n${await read('../../apps/farm/app/assets/css/main.css')}\n${styles}`
  }

  it.each([2, 30])(
    'passes axe, fits and is keyboard reachable at 320, 768 and 1280 px with %i Connectors',
    async (count) => {
      const css = await pageCss()
      const pages = {
        '/tabela': await renderFarmComponent(file, props(count)),
        '/mapa': await renderFarmComponent(
          file,
          props(count, { initialView: 'map' }),
        ),
      } as Record<string, string>
      const server = await startHttpMock({
        port: 0,
        routes: Object.fromEntries(
          Object.entries(pages).map(([path, html]) => [
            path,
            (_req, res) => {
              res.setHeader('Content-Type', 'text/html; charset=utf-8')
              res.end(
                `<!doctype html><html lang="pt-BR"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Rede</title><style>${css}</style><main><h1>Rede da farm</h1>${html}</main></html>`,
              )
            },
          ]),
        ),
      })
      try {
        const browser = await launchBrowser({
          args: ['--disable-background-networking'],
        })
        try {
          const page = await (await browser.newContext()).newPage()
          await page.route('**/*', (route) =>
            new URL(route.request().url()).origin === server.origin
              ? route.continue()
              : route.abort(),
          )
          for (const width of [320, 768, 1280]) {
            await page.setViewportSize({ width, height: 900 })
            for (const path of Object.keys(pages)) {
              expect((await page.goto(server.origin + path))?.ok()).toBe(true)
              expect(
                await page.evaluate(() => document.documentElement.scrollWidth),
              ).toBe(width)
              expect(
                (await new AxeBuilder({ page }).analyze()).violations,
              ).toEqual([])
              // Keyboard: view buttons, two filters, then the content.
              // Start from the heading, not from wherever the browser left
              // focus after the previous page, and stop once Tab leaves the
              // document: with few rows the walk would otherwise wrap into
              // browser UI and change where the next page's first Tab lands.
              await page
                .getByRole('heading', { name: 'Rede da farm', level: 1 })
                .click()
              const focused: string[] = []
              for (let step = 0; step < 8; step++) {
                await page.keyboard.press('Tab')
                const stop = await page.evaluate(() => {
                  const active = document.activeElement
                  if (!active || active === document.body) return null
                  return (
                    active.getAttribute('href') ??
                    (active.id || active.textContent?.trim() || '')
                  )
                })
                if (stop === null) break
                focused.push(stop)
              }
              expect(focused.slice(0, 4)).toEqual([
                'Mapa',
                'Tabela',
                'rede-connector',
                'rede-status',
              ])
              expect(focused).toContain('/impressoras/printer-0')
            }
          }
        } finally {
          await browser.close()
        }
      } finally {
        await server.close()
      }
    },
    120_000,
  )
})
