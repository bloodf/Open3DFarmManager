// SPDX-License-Identifier: MIT
import { readFile } from 'node:fs/promises'
import AxeBuilder from '@axe-core/playwright'
import { parse } from 'vue/compiler-sfc'
import { afterEach, describe, expect, it } from 'vitest'
import { renderFarmComponent } from '../helpers/render-farm-component.ts'
import {
  HISTORY_MAX_ROWS,
  HISTORY_PAGE_SIZE,
  durationText,
  filamentText,
  historyPage,
  mergeHistory,
  type PrinterHistoryJob,
} from '../../apps/farm/app/components/printer-detail/history-view.ts'
import { detailTabs } from '../../apps/farm/app/utils/printer-detail-view.ts'
import type { JobHistoryItem } from '../../apps/farm/app/utils/job-history-view.ts'
import {
  HISTORY_MAX_ITEMS,
  HISTORY_PAGE,
  readDetailHistory,
  readDetailTotals,
} from '../../packages/connector/src/moonraker/control-history.ts'
import { PrinterDetailStreamQueryResponse } from '../../packages/farm-protocol/src/printer-detail.ts'
import { startHttpMock } from '../../packages/sim-tools/src/mocks/http-mock.ts'
import {
  startMoonrakerMock,
  type MoonrakerMockInstance,
} from '../../packages/sim-tools/src/mocks/moonraker-mock.ts'
import { launchBrowser } from '../helpers/browser.ts'

const panel = '../printer-detail/HistoryPanel.vue'
const end = Date.UTC(2026, 10, 19, 12)
const job = (
  index: number,
  extra: Partial<PrinterHistoryJob> = {},
): PrinterHistoryJob => ({
  id: index.toString(16).padStart(6, '0'),
  file: `peca-${index}.gcode`,
  state: 'completed',
  startedAtMs: end - index * 3_600_000 - 1_800_000,
  durationSeconds: 1800,
  ...extra,
})
const linked: JobHistoryItem = {
  id: 'of-1',
  printerKey: 'printer-a',
  outcome: 'completed',
  filename: 'peca-1.gcode',
  printDurationSeconds: 1700,
  librarySha256: 'a'.repeat(64),
  plate: 1,
  endedAt: end - 3_600_000 + 40_000,
}
const totals = {
  jobs: 12,
  printSeconds: 90_000,
  filamentMm: 12_345,
  longestJobSeconds: 7200,
}
const base = {
  advertised: true,
  jobs: [job(1), job(2, { state: 'cancelled' })],
  totals,
  openfarmJobs: [linked],
  replayHref: (sha: string) => `/biblioteca?versao=${sha}`,
}

let mock: MoonrakerMockInstance | undefined
afterEach(async () => {
  await mock?.close()
  mock = undefined
})

describe('history adapter', () => {
  const signal = new AbortController().signal

  it('pages Moonraker history within the bound and validates the reply', async () => {
    const calls: Array<Record<string, unknown>> = []
    const request = async (method: string, params?: object) => {
      expect(method).toBe('server.history.list')
      calls.push({ ...params })
      const start = Number((params as { start: number }).start)
      return {
        count: 1000,
        jobs: Array.from({ length: HISTORY_PAGE }, (_, i) => ({
          job_id: String(start + i),
          filename: `f${start + i}.gcode\u0007`,
          status: 'completed',
          start_time: 1_700_000_000 + start + i,
          end_time: 1_700_000_100 + start + i,
          total_duration: 100.9,
        })),
      }
    }
    const jobs = await readDetailHistory(request, signal)
    expect(jobs).toHaveLength(HISTORY_MAX_ITEMS)
    expect(calls).toHaveLength(HISTORY_MAX_ITEMS / HISTORY_PAGE)
    expect(calls.map((call) => call.start)).toEqual([0, 64, 128, 192])
    expect(jobs.map(({ id }) => id)).toEqual(
      Array.from({ length: HISTORY_MAX_ITEMS }, (_, index) => String(index)),
    )
    expect(jobs[0]).toEqual({
      id: '0',
      file: 'f0.gcode',
      state: 'completed',
      startedAtMs: 1_700_000_000_000,
      durationSeconds: 100,
    })
    expect(
      PrinterDetailStreamQueryResponse.safeParse({
        v: 1,
        t: 'query.response',
        printerKey: 'printer-a',
        requestId: 'h',
        kind: 'history',
        data: jobs,
      }).success,
    ).toBe(true)
  })

  it('stops on a short page, skips unusable entries, honours abort', async () => {
    const request = async () => ({
      count: 3,
      jobs: [
        { job_id: 'a', filename: 'x.gcode', status: 'error', start_time: 5 },
        { job_id: '', filename: 'y.gcode', status: 'completed' },
        { job_id: 'c', filename: '', status: 'completed' },
      ],
    })
    expect(await readDetailHistory(request, signal)).toEqual([
      {
        id: 'a',
        file: 'x.gcode',
        state: 'error',
        startedAtMs: 5000,
        durationSeconds: 0,
      },
    ])
    const aborted = new AbortController()
    aborted.abort()
    await expect(readDetailHistory(request, aborted.signal)).rejects.toThrow()
  })

  it('reads totals including the longest job, and omits it when absent', async () => {
    expect(
      await readDetailTotals(async () => ({
        job_totals: {
          total_jobs: 4,
          total_print_time: 100.5,
          total_filament_used: 2500,
          longest_job: 600,
        },
      })),
    ).toEqual({
      jobs: 4,
      printSeconds: 100,
      filamentMm: 2500,
      longestJobSeconds: 600,
    })
    expect(await readDetailTotals(async () => ({}))).toEqual({
      jobs: 0,
      printSeconds: 0,
      filamentMm: 0,
    })
  })

  it('answers from the loopback Moonraker mock (port 0)', async () => {
    mock = await startMoonrakerMock({})
    for (let i = 0; i < 3; i++) {
      mock.control.update({ state: 'printing', filename: `j${i}.gcode` })
      mock.control.update({ state: 'complete' })
    }
    const url = new URL(mock.origin)
    expect(url.hostname).toBe('127.0.0.1')
    const request = async (method: string, params?: object) => {
      const query = new URLSearchParams(
        Object.entries(params ?? {}).map(([k, v]) => [k, String(v)]),
      )
      const path = method.replace('server.history.', '/server/history/')
      const reply = await fetch(`${mock!.origin}${path}?${query}`)
      return (await reply.json()).result
    }
    const jobs = await readDetailHistory(request, signal)
    expect(jobs.map((item) => item.file)).toEqual([
      'j2.gcode',
      'j1.gcode',
      'j0.gcode',
    ])
    expect((await readDetailTotals(request)).jobs).toBe(3)
  })
})

describe('history view', () => {
  it('merges the printer and OpenFarm histories, linking known jobs once', () => {
    const rows = mergeHistory(base.jobs, [
      linked,
      { ...linked, id: 'of-dup' },
      { ...linked, id: 'of-only', filename: 'outro.gcode', endedAt: end + 1 },
    ])
    expect(rows.map((row) => [row.filename, row.source])).toEqual([
      ['outro.gcode', 'openfarm'],
      ['peca-1.gcode', 'openfarm'],
      ['peca-1.gcode', 'both'],
      ['peca-2.gcode', 'moonraker'],
    ])
    expect(rows[2]).toMatchObject({
      librarySha256: linked.librarySha256,
      openfarmJobId: 'of-1',
    })
    expect(rows[3]).not.toHaveProperty('librarySha256')
    expect(rows[3]?.outcome).toBe('Cancelado')
  })

  it('maps unknown states to failed and bounds rows and pages', () => {
    expect(
      mergeHistory([job(1, { state: 'klippy_shutdown' })], [])[0]?.outcome,
    ).toBe('Falhou')
    const many = Array.from({ length: 400 }, (_, i) => job(i + 1))
    expect(mergeHistory(many, [])).toHaveLength(HISTORY_MAX_ROWS)
    const rows = Array.from({ length: 45 }, (_, i) => i)
    expect(historyPage(rows, 1).rows).toHaveLength(HISTORY_PAGE_SIZE)
    expect(historyPage(rows, 3)).toMatchObject({ page: 3, pages: 3 })
    expect(historyPage(rows, 3).rows).toHaveLength(5)
    expect(historyPage(rows, 99).page).toBe(3)
    expect(historyPage(rows, -4).page).toBe(1)
    expect(historyPage([], Number.NaN)).toEqual({ page: 1, pages: 1, rows: [] })
  })

  it('formats durations and filament in pt-BR', () => {
    expect(durationText(7200)).toBe('2 h 0 min')
    expect(durationText(90)).toBe('1 min')
    expect(durationText(30)).toBe('30 s')
    expect(durationText(undefined)).toBe('Não informada')
    expect(filamentText(12_345)).toBe('12,3 m')
  })

  it('keeps the tab out of the list, with the reason, without the job capability', () => {
    const reasons = { job: 'Sem histórico nesta impressora.' }
    expect(detailTabs(['console'], reasons).unavailable).toContainEqual(
      expect.objectContaining({
        id: 'historico',
        reason: 'Sem histórico nesta impressora.',
      }),
    )
    expect(
      detailTabs(['job'], reasons).available.map(({ id }) => id),
    ).toContain('historico')
  })
})

describe('HistoryPanel', () => {
  it('shows totals, merged rows and the replay link only for linked jobs', async () => {
    const html = await renderFarmComponent(panel, base)
    for (const text of [
      'Trabalhos',
      '12',
      '25 h 0 min',
      '12,3 m',
      'Maior trabalho',
      '2 h 0 min',
      'peca-1.gcode',
      'Impressora e OpenFarm',
      'Cancelado',
    ])
      expect(html).toContain(text)
    expect(html.match(/Imprimir de novo/g)).toHaveLength(2)
    expect(html).toContain(`href="/biblioteca?versao=${'a'.repeat(64)}"`)
    expect(html).toContain('Sem vínculo com a biblioteca')
    expect(html).not.toContain('Próxima página')
  })

  it('offers no replay link when the host gives no target', async () => {
    const html = await renderFarmComponent(panel, {
      ...base,
      replayHref: undefined,
    })
    expect(html).not.toContain('<a')
  })

  it('shows the catalog reason and no data when not advertised', async () => {
    const html = await renderFarmComponent(panel, {
      ...base,
      advertised: false,
      disabledReason: 'Sem histórico nesta impressora.',
    })
    expect(html).toContain('Sem histórico nesta impressora.')
    expect(html).not.toContain('<table')
  })

  it('paginates with a bounded page and never shows stale data after an error', async () => {
    const many = Array.from({ length: 400 }, (_, i) => job(i + 1))
    const html = await renderFarmComponent(panel, { ...base, jobs: many })
    expect(html.match(/<tr/g)).toHaveLength(HISTORY_PAGE_SIZE + 1)
    expect(html).toContain('Página 1 de 13')
    expect(html).toMatch(/Página anterior/)
    const failed = await renderFarmComponent(panel, {
      ...base,
      error: 'Não foi possível consultar o histórico.',
    })
    expect(failed).toContain('role="alert"')
    expect(failed).not.toContain('<table')
    expect(failed).not.toContain('peca-1')
    const empty = await renderFarmComponent(panel, {
      ...base,
      jobs: [],
      openfarmJobs: [],
    })
    expect(empty).toContain('Nenhum trabalho finalizado registrado.')
  })

  it('passes axe and fits at 320, 768 and 1280 px', async () => {
    const many = Array.from({ length: 45 }, (_, i) => job(i + 1))
    const html = await renderFarmComponent(panel, { ...base, jobs: many })
    const read = (path: string) =>
      readFile(new URL(path, import.meta.url), 'utf8')
    const css = `${await read('../../apps/farm/app/assets/tokens/tokens.css')}\n${await read('../../apps/farm/app/assets/css/main.css')}\n${(
      await Promise.all(
        [
          '../../apps/farm/app/components/printer-detail/HistoryPanel.vue',
          '../../apps/farm/app/components/ui/Button.vue',
        ].map(async (path) =>
          parse(await read(path)).descriptor.styles.map((s) => s.content),
        ),
      )
    )
      .flat()
      .join('\n')}`
    const server = await startHttpMock({
      port: 0,
      routes: {
        '/': (_req, res) => {
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.end(
            `<!doctype html><html lang="pt-BR"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Histórico</title><style>${css}</style><main><h1>Impressora</h1>${html}</main></html>`,
          )
        },
      },
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
          expect((await page.goto(server.origin))?.ok()).toBe(true)
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth),
          ).toBe(width)
          expect((await new AxeBuilder({ page }).analyze()).violations).toEqual(
            [],
          )
        }
      } finally {
        await browser.close()
      }
    } finally {
      await server.close()
    }
  }, 120_000)
})
