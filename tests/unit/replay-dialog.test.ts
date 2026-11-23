// SPDX-License-Identifier: MIT
// In-process only: components run in a headless browser fed by setContent, with
// the signed command replaced by a recording function. No network, no printer.
import { readFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { build } from 'esbuild'
import { compileScript, parse } from 'vue/compiler-sfc'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchBrowser, type Browser } from '../helpers/browser'
import {
  REFUSAL_TEXT,
  buildArgs,
  confirmationError,
  defaultPrinter,
  groupPrinters,
  replayOutcomeText,
  suggestMapping,
  type ReplayPrinter,
  type ReplaySource,
} from '../../apps/farm/app/utils/replay-view'

const SHA = 'a'.repeat(64)
const AGENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const OTHER_AGENT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

const gcode: ReplaySource = {
  sha256: SHA,
  name: 'vaso.gcode',
  kind: 'gcode',
  plateCount: 1,
  storageLocation: 'server',
  agentId: null,
  metadata: {
    printerModel: 'Voron 2.4',
    tools: [{ nozzleDiameter: 0.4, filamentType: 'PLA' }],
  },
}
const threeMf: ReplaySource = {
  ...gcode,
  name: 'suporte.3mf',
  kind: '3mf',
  plateCount: 3,
  metadata: {
    printerModel: 'X1C',
    tools: [
      { nozzleDiameter: 0.4, filamentType: 'PLA', filamentColour: '#ff0000' },
      { nozzleDiameter: 0.4, filamentType: 'PETG', filamentColour: '#0000ff' },
    ],
  },
}
const printer = (
  key: string,
  over: Partial<ReplayPrinter> = {},
): ReplayPrinter => ({
  key,
  label: `Impressora ${key}`,
  agentId: AGENT,
  model: 'Voron 2.4',
  nozzleDiameters: [0.4],
  connectorOnline: true,
  live: true,
  state: 'idle',
  materials: [{ slot: '0', materialType: 'PLA', colorHex: 'FF0000FF' }],
  ...over,
})
const voron = printer('voron')
const petg = printer('petg', {
  materials: [{ slot: '0', materialType: 'PETG' }],
})
const ender = printer('ender', { model: 'Ender 3' })
const offline = printer('offline', { connectorOnline: false })
const busy = printer('busy', { state: 'printing' })
const x1c = printer('x1c', {
  model: 'X1C',
  backend: 'bambu',
  nozzleDiameters: [0.4, 0.4],
  materials: [
    { slot: '0', materialType: 'PLA', colorHex: '00FF00FF' },
    { slot: '1', materialType: 'PLA', colorHex: 'FF0000FF' },
    { slot: '2', materialType: 'PETG', colorHex: '0000FFFF' },
  ],
})

describe('replay grouping and mapping', () => {
  const groups = groupPrinters(gcode, [
    voron,
    petg,
    ender,
    offline,
    busy,
    printer('nolive', { live: false }),
  ])
  const keys = (level: 'ok' | 'warn' | 'blocked') =>
    groups[level].map((e) => e.printer.key)

  it('groups by compatibility, with reasons, and disables unavailable printers', () => {
    expect(keys('ok')).toEqual(['voron'])
    expect(keys('warn')).toEqual(['petg'])
    expect(groups.warn[0]!.reasons.join(' ')).toMatch(/material carregado/)
    expect(keys('blocked')).toEqual(['ender', 'offline', 'busy', 'nolive'])
    expect(groups.blocked[0]!.reasons.join(' ')).toMatch(/incompatível/)
    expect(groups.blocked[1]!.disabledReason).toMatch(/offline/)
    expect(groups.blocked[2]!.disabledReason).toMatch(/não está ociosa/)
    expect(groups.blocked[3]!.disabledReason).toMatch(/conexão direta segura/)
  })
  it('preselects the same printer only when it can be used', () => {
    expect(defaultPrinter(groups, 'voron')).toBe('voron')
    expect(defaultPrinter(groups, 'petg')).toBe('petg')
    expect(defaultPrinter(groups, 'offline')).toBe('voron')
    expect(defaultPrinter(groups, undefined)).toBe('voron')
    expect(defaultPrinter(groupPrinters(gcode, [ender]), 'ender')).toBe('')
  })
  it('keeps the file with the Connector that stores it (Connector mode)', () => {
    const local = {
      ...gcode,
      storageLocation: 'connector' as const,
      agentId: AGENT,
    }
    const g = groupPrinters(local, [
      voron,
      printer('other', { agentId: OTHER_AGENT }),
      printer('off', { connectorOnline: false }),
    ])
    expect(g.ok.map((e) => e.printer.key)).toEqual(['voron'])
    expect(g.blocked[0]!.disabledReason).toMatch(/outro Connector/)
    expect(g.blocked[1]!.disabledReason).toMatch(
      /Connector que guarda o arquivo está offline/,
    )
  })
  it('disables everything when the stored file was removed', () => {
    const g = groupPrinters({ ...gcode, purged: true }, [voron])
    expect(g.ok).toEqual([])
    expect(g.blocked[0]!.disabledReason).toMatch(/removido da biblioteca/)
  })
  it('maps filaments to loaded slots by colour, then type, without reuse', () => {
    expect(suggestMapping(threeMf, x1c)).toEqual([1, 2])
    const noMatch = printer('x', {
      materials: [{ slot: '0', materialType: 'ABS' }],
    })
    expect(suggestMapping(threeMf, noMatch)).toEqual([-1, -1])
  })
  it('builds the signed arguments: plate and AMS only for Bambu 3MF', () => {
    const choice = {
      printer: x1c,
      source: threeMf,
      plate: 2,
      mapping: [1, 2],
      bedClear: true,
    }
    expect(buildArgs(choice)).toEqual({
      sha256: SHA,
      plate: 2,
      ams_mapping: [1, 2],
    })
    expect(buildArgs({ ...choice, printer: voron, source: gcode })).toEqual({
      sha256: SHA,
    })
  })
  it('asks for the bed and for every slot before confirming', () => {
    const choice = {
      printer: x1c,
      source: threeMf,
      plate: 1,
      mapping: [1, -1],
      bedClear: false,
    }
    expect(confirmationError(choice)).toMatch(/slot/)
    expect(confirmationError({ ...choice, mapping: [1, 2] })).toMatch(/mesa/)
    expect(
      confirmationError({ ...choice, mapping: [1, 2], bedClear: true }),
    ).toBeUndefined()
  })
  it('explains each Connector refusal in plain pt-BR and never offers a retry', () => {
    for (const code of Object.keys(REFUSAL_TEXT)) {
      const text = replayOutcomeText({ outcome: 'rejected', code })
      expect(text).toContain(REFUSAL_TEXT[code]!)
      expect(text).toContain('nada será repetido automaticamente')
    }
    expect(replayOutcomeText({ outcome: 'rejected', code: 'novo' })).toMatch(
      /O Connector recusou o comando/,
    )
    // A refusal the Connector reports before anything reaches the printer
    // arrives as "not sent" with its code: the reason is shown, not hidden.
    expect(
      replayOutcomeText({ outcome: 'not-sent', code: 'incompatible' }),
    ).toBe(
      `${REFUSAL_TEXT.incompatible} A impressão não foi iniciada e nada será repetido automaticamente.`,
    )
    expect(replayOutcomeText({ outcome: 'not-sent', code: 'novo' })).toMatch(
      /não foi enviado ao Connector/,
    )
    expect(replayOutcomeText({ outcome: 'not-sent' })).toMatch(
      /não foi enviado ao Connector/,
    )
    expect(replayOutcomeText({ outcome: 'outcome-unknown' })).toMatch(
      /Verifique a impressora/,
    )
    expect(replayOutcomeText({ outcome: 'applied', source: 'local' })).toMatch(
      /biblioteca do Connector/,
    )
  })
})

describe('replay dialog in a browser', () => {
  let browser: Browser
  let appJs = ''

  beforeAll(async () => {
    const result = await build({
      stdin: {
        contents: `
          import { createApp, h, ref } from 'vue'
          import ReplayDialog from './apps/farm/app/components/library/ReplayDialog.vue'
          import ReplayAction from './apps/farm/app/components/history/ReplayAction.vue'
          window.mountReplay = (kind, props) => {
            const open = ref(true)
        const current = ref(props)
        window.refreshReplay = () => { current.value = { ...current.value, source: { ...current.value.source } } }
            window.__sent = []
            const send = async (key, args) => {
              window.__sent.push({ key, args })
              if (window.__reply === 'throw') throw new Error('rtc')
              return window.__reply
            }
            createApp({
              render: () =>
                kind === 'dialog'
                  ? h(ReplayDialog, { ...current.value, send, modelValue: open.value, 'onUpdate:modelValue': (v) => (open.value = v) })
                  : h(ReplayAction, { ...props, send }),
            }).mount('#app')
          }
        `,
        resolveDir: process.cwd(),
      },
      bundle: true,
      write: false,
      outfile: 'app.js',
      define: { 'process.env.NODE_ENV': '"production"' },
      plugins: [
        {
          name: 'vue-sfc',
          setup(b) {
            b.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
              const { descriptor, errors } = parse(
                await readFile(path, 'utf8'),
                { filename: path },
              )
              if (errors.length) throw new Error(errors.join('\n'))
              const id = `data-v-${basename(path, '.vue')}`
              const code = compileScript(descriptor, {
                id,
                inlineTemplate: true,
                genDefaultAs: 'component',
              }).content
              // Scoped styles are skipped: no layout is asserted here.
              return {
                loader: 'ts',
                resolveDir: dirname(path),
                contents: `${code}\ncomponent.__scopeId = ${JSON.stringify(id)}\nexport default component`,
              }
            })
          },
        },
      ],
    })
    appJs = result.outputFiles.find((f) => f.path.endsWith('.js'))!.text
    browser = await launchBrowser({ args: ['--disable-background-networking'] })
  }, 30_000)

  afterAll(async () => {
    await Promise.race([
      browser?.close(),
      new Promise((resolve) => setTimeout(resolve, 5_000).unref()),
    ])
  })

  /** Opens a blank page with the bundle and mounts one component. */
  async function mount(
    kind: 'dialog' | 'action',
    props: Record<string, unknown>,
    reply: unknown = { outcome: 'applied', source: 'cache' },
  ) {
    const context = await browser.newContext()
    await context.route('**/*', (route) => route.abort())
    const page = await context.newPage()
    await page.setContent(
      '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Reimpressão</title></head><body><main><div id="app"></div></main></body></html>',
    )
    await page.addScriptTag({ content: appJs })
    await page.evaluate(
      ([k, p, r]) => {
        const w = window as unknown as Record<string, any>
        w.__reply = r
        w.mountReplay(k, p)
      },
      [kind, props, reply] as const,
    )
    const sent = () =>
      page.evaluate(() => (window as unknown as { __sent: unknown[] }).__sent)
    return { page, sent, close: () => context.close() }
  }
  const radio = (page: Page, label: string) =>
    page.getByRole('radio', { name: label })
  const base = { source: gcode, printers: [voron, petg, ender, offline] }

  it('shows the groups, the reasons and preselects the same printer', async () => {
    const { page, close } = await mount('dialog', {
      ...base,
      preferredPrinter: 'petg',
    })
    try {
      for (const name of [
        'Compatíveis',
        'Compatíveis com ressalvas',
        'Bloqueadas ou indisponíveis',
      ])
        await page.getByRole('heading', { name, exact: true }).waitFor()
      expect(await radio(page, 'Impressora petg').isChecked()).toBe(true)
      expect(await radio(page, 'Impressora ender').isDisabled()).toBe(true)
      expect(await radio(page, 'Impressora offline').isDisabled()).toBe(true)
      const text = await page.locator('dialog').innerText()
      expect(text).toContain('material carregado na ferramenta 1 difere')
      expect(text).toContain('O Connector desta impressora está offline.')
      expect(text).toContain('modelo de impressora indicado no arquivo')
    } finally {
      await close()
    }
  })

  it('needs the bed confirmation, then sends one signed command and shows the result', async () => {
    const { page, sent, close } = await mount('dialog', {
      ...base,
      preferredPrinter: 'voron',
    })
    try {
      const go = page.getByRole('button', { name: 'Imprimir de novo' })
      expect(await go.isDisabled()).toBe(true)
      await page.getByText('Confirme que a mesa está limpa.').waitFor()
      await page.getByLabel('Confirmo que a mesa está limpa').check()
      await go.click()
      await page.getByText('Impressão iniciada').waitFor()
      expect(await sent()).toEqual([{ key: 'voron', args: { sha256: SHA } }])
      expect(await page.locator('dialog').innerText()).toContain(
        'cache do Connector',
      )
      // Settled: the command cannot be sent a second time from this dialog.
      expect(await go.isDisabled()).toBe(true)
    } finally {
      await close()
    }
  })

  it('keeps a settled command locked when the source is refreshed', async () => {
    const { page, sent, close } = await mount('dialog', {
      ...base,
      preferredPrinter: 'voron',
    })
    try {
      await page.getByLabel('Confirmo que a mesa está limpa').check()
      await page.getByRole('button', { name: 'Imprimir de novo' }).click()
      await page.getByText('Impressão iniciada').waitFor()
      await page.evaluate(() =>
        (window as unknown as { refreshReplay(): void }).refreshReplay(),
      )
      expect(await page.getByText('Impressão iniciada').isVisible()).toBe(true)
      expect(
        await page
          .getByRole('button', { name: 'Imprimir de novo' })
          .isDisabled(),
      ).toBe(true)
      expect(await sent()).toHaveLength(1)
    } finally {
      await close()
    }
  })

  it('maps AMS slots with loaded colours and sends plate and mapping', async () => {
    const { page, sent, close } = await mount('dialog', {
      source: threeMf,
      printers: [x1c],
      preferredPrinter: 'x1c',
      preferredPlate: 2,
    })
    try {
      expect(await page.getByLabel('Placa').inputValue()).toBe('2')
      const first = page.getByLabel(/Filamento 1/)
      const second = page.getByLabel(/Filamento 2/)
      expect(await first.inputValue()).toBe('1')
      expect(await second.inputValue()).toBe('2')
      expect(await first.locator('option').allInnerTexts()).toContain(
        'Slot 1: PLA · #FF0000',
      )
      await first.selectOption('0')
      const go = page.getByRole('button', { name: 'Imprimir de novo' })
      await page.getByLabel('Confirmo que a mesa está limpa').check()
      await go.click()
      await page.getByText('Impressão iniciada').waitFor()
      expect(await sent()).toEqual([
        { key: 'x1c', args: { sha256: SHA, plate: 2, ams_mapping: [0, 2] } },
      ])
    } finally {
      await close()
    }
  })

  it('blocks the command while a filament has no slot', async () => {
    const { page, sent, close } = await mount('dialog', {
      source: threeMf,
      printers: [x1c],
    })
    try {
      await page.getByLabel(/Filamento 2/).selectOption('-1')
      await page.getByLabel('Confirmo que a mesa está limpa').check()
      await page.getByText('Associe cada filamento').waitFor()
      expect(
        await page
          .getByRole('button', { name: 'Imprimir de novo' })
          .isDisabled(),
      ).toBe(true)
      expect(await sent()).toEqual([])
    } finally {
      await close()
    }
  })

  it.each([
    [
      'server mode shows the cache/download path',
      gcode,
      'O Connector usa o cache dele ou baixa o arquivo do servidor',
    ],
    [
      'Connector mode says the file is kept on the Connector',
      { ...gcode, storageLocation: 'connector', agentId: AGENT },
      'O arquivo fica guardado no Connector e o servidor não tem cópia',
    ],
  ])('%s', async (_name, source, note) => {
    const { page, close } = await mount('dialog', {
      source,
      printers: [voron],
    })
    try {
      const text = await page.getByTestId('storage-note').innerText()
      expect(text).toContain(note)
      expect(text).toContain(
        source.storageLocation === 'connector'
          ? 'Guardado em: Connector'
          : 'Guardado em: Servidor',
      )
    } finally {
      await close()
    }
  })

  it('in Connector mode refuses an offline Connector and a missing file', async () => {
    const local = { ...gcode, storageLocation: 'connector', agentId: AGENT }
    const off = await mount('dialog', {
      source: local,
      printers: [printer('voron', { connectorOnline: false })],
    })
    try {
      await off.page
        .getByText('O Connector que guarda o arquivo está offline')
        .waitFor()
      expect(await radio(off.page, 'Impressora voron').isDisabled()).toBe(true)
    } finally {
      await off.close()
    }
    const gone = await mount('dialog', {
      source: { ...local, purged: true },
      printers: [voron],
    })
    try {
      await gone.page
        .getByRole('alert')
        .getByText(/foi removido da biblioteca/)
        .waitFor()
      expect(await radio(gone.page, 'Impressora voron').isDisabled()).toBe(true)
    } finally {
      await gone.close()
    }
    // The Connector can still find the file gone when it checks its own copy.
    const missing = await mount(
      'dialog',
      { source: local, printers: [voron], preferredPrinter: 'voron' },
      { outcome: 'rejected', code: 'local-file-missing' },
    )
    try {
      await missing.page.getByLabel('Confirmo que a mesa está limpa').check()
      await missing.page
        .getByRole('button', { name: 'Imprimir de novo' })
        .click()
      const alert = missing.page.getByRole('alert')
      await alert.getByText(/não está na biblioteca do Connector/).waitFor()
      expect(await alert.innerText()).toContain('nada será repetido')
    } finally {
      await missing.close()
    }
  })

  it('shows the Connector refusal reasons in pt-BR', async () => {
    const { page, close } = await mount(
      'dialog',
      { ...base, preferredPrinter: 'voron' },
      {
        outcome: 'rejected',
        code: 'incompatible',
        reasons: [
          'O diâmetro do bico da ferramenta 1 difere do indicado no arquivo.',
        ],
      },
    )
    try {
      await page.getByLabel('Confirmo que a mesa está limpa').check()
      await page.getByRole('button', { name: 'Imprimir de novo' }).click()
      const alert = page.getByRole('alert')
      await alert
        .getByText('O arquivo é incompatível com esta impressora.', {
          exact: false,
        })
        .waitFor()
      expect(await alert.innerText()).toContain('diâmetro do bico')
    } finally {
      await close()
    }
  })

  it('treats a failed send as uncertain and never resends it', async () => {
    const { page, sent, close } = await mount(
      'dialog',
      { ...base, preferredPrinter: 'voron' },
      'throw',
    )
    try {
      await page.getByLabel('Confirmo que a mesa está limpa').check()
      const go = page.getByRole('button', { name: 'Imprimir de novo' })
      await go.click()
      await page
        .getByRole('alert')
        .getByText(/Verifique a impressora/)
        .waitFor()
      expect(await go.isDisabled()).toBe(true)
      expect(await sent()).toHaveLength(1)
    } finally {
      await close()
    }
  })

  it('history action: hidden for unlinked jobs, preselects the job printer and plate', async () => {
    const unlinked = await mount('action', {
      job: { id: 'j', printerKey: 'voron', outcome: 'completed', endedAt: 1 },
      source: gcode,
      printers: [voron],
    })
    try {
      expect(
        await unlinked.page
          .getByRole('button', { name: /Imprimir de novo/ })
          .count(),
      ).toBe(0)
    } finally {
      await unlinked.close()
    }
    const linked = await mount('action', {
      job: {
        id: 'j',
        printerKey: 'x1c',
        outcome: 'completed',
        filename: 'suporte.3mf',
        librarySha256: SHA,
        plate: 3,
        endedAt: 1,
      },
      source: threeMf,
      printers: [voron, x1c],
    })
    try {
      await linked.page
        .getByRole('button', { name: 'Imprimir de novo suporte.3mf' })
        .click()
      expect(await radio(linked.page, 'Impressora x1c').isChecked()).toBe(true)
      expect(await linked.page.getByLabel('Placa').inputValue()).toBe('3')
    } finally {
      await linked.close()
    }
    const gone = await mount('action', {
      job: {
        id: 'j',
        printerKey: 'voron',
        outcome: 'failed',
        librarySha256: SHA,
        endedAt: 1,
      },
      printers: [voron],
    })
    try {
      await gone.page.getByText('não está disponível').waitFor()
      expect(
        await gone.page
          .getByRole('button', { name: /Imprimir de novo/ })
          .isDisabled(),
      ).toBe(true)
    } finally {
      await gone.close()
    }
  })

  it('has no accessibility violations', async () => {
    const { page, close } = await mount('dialog', {
      source: threeMf,
      printers: [x1c, voron, offline],
    })
    try {
      await page.getByRole('heading', { name: 'Imprimir de novo' }).waitFor()
      const { violations } = await new AxeBuilder({ page }).analyze()
      expect(violations.map((v) => v.id)).toEqual([])
    } finally {
      await close()
    }
  })
})
