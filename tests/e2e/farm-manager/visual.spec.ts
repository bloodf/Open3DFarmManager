// Visual regression for the key pages (#439): farm (cards and table), printer
// detail, library, Rede and Painel, light and dark, at 390, 768 and 1280 px.
// One Moonraker mock with fixed telemetry and one library item keep the data
// fixed and the clock is frozen from the start, so no direct connection is
// ever renewed: every page shows the same read-only, last-known view. The
// values a run generates (identifiers, fingerprints, instants) are shown as
// fixed text so the layout stays the real one. Only the camera video is
// masked.
import type { Page } from '@playwright/test'
import {
  FROZEN_INSTANT,
  expect,
  freezeClock,
  setTheme,
  test,
  type FarmManager,
  type Theme,
} from './fixtures.ts'

const printerKey = 'moonraker-visual'
const WIDTHS = [390, 768, 1280] as const
const THEMES: readonly Theme[] = ['light', 'dark']

/** Shows run-generated values as fixed text, now and after every re-render. */
function fixGeneratedValues() {
  const rules: readonly [RegExp, string][] = [
    [
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      '00000000-0000-4000-8000-000000000000',
    ],
    [/[A-Za-z0-9_-]{43}/g, 'A'.repeat(43)],
    [/\d{2}\/\d{2}\/\d{4}(, \d{2}:\d{2}(:\d{2})?)?/g, '15/01/2026, 12:00:00'],
    [/\b\d{2}:\d{2}(:\d{2})?\b/g, '12:00:00'],
    [/Connector [0-9a-f]{8}\b/g, 'Connector 00000000'],
    [/\b\d+ ms\b/g, '1 ms'],
    [/há \d+ (s|min|h)\b/g, 'há 0 s'],
  ]
  const fix = (root: Node) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const before = node.nodeValue ?? ''
      let after = before
      for (const [pattern, text] of rules) after = after.replace(pattern, text)
      if (after !== before) node.nodeValue = after
    }
  }
  const start = () => {
    fix(document.body)
    new MutationObserver(() => fix(document.body)).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    })
  }
  if (document.body) start()
  else document.addEventListener('DOMContentLoaded', start)
}

async function hydrated(page: Page) {
  await page.waitForFunction(() => {
    const root = document.querySelector('#__nuxt')
    return root && '__vue_app__' in root
  })
  await expect(page.locator('main')).toBeVisible()
  await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0)
}

/** Waits until the page text stops changing (no load or retry in flight). */
async function settled(page: Page, seconds: number) {
  let previous = ''
  let steady = 0
  await expect
    .poll(
      async () => {
        const text = await page.locator('body').innerText()
        steady = text === previous ? steady + 1 : 0
        previous = text
        return steady
      },
      { intervals: [500], timeout: 30_000 },
    )
    .toBeGreaterThanOrEqual(seconds * 2)
}

/** Chooses the theme as a person does, then waits for the page to show it. */
async function chooseTheme(page: Page, theme: Theme) {
  await setTheme(page, theme)
  const select = page.getByRole('combobox', { name: 'Tema', exact: true })
  // The Painel has no shell: it is dark whatever the choice.
  if (await select.count())
    await select.selectOption({ label: theme === 'dark' ? 'Escuro' : 'Claro' })
  if (new URL(page.url()).pathname !== '/painel')
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
}

type Shot = Readonly<{
  name: string
  open(page: Page, farm: FarmManager): Promise<void>
  /** Puts the open page in the state to capture. */
  show?(page: Page): Promise<void>
}>

const SHOTS: readonly Shot[] = [
  {
    name: 'farm-cards',
    async open(page, farm) {
      await page.goto(farm.origin + '/farm')
      await hydrated(page)
      // The summary reads the last state the server holds a moment after load.
      await expect(
        page.getByRole('region', { name: 'Resumo da farm' }),
      ).toContainText('Imprimindo: 1', { timeout: 30_000 })
    },
    async show(page) {
      await page.getByRole('button', { name: 'Cartões' }).click()
      await expect(page.locator('.printer-card')).toHaveCount(1)
    },
  },
  {
    name: 'farm-table',
    async open(page, farm) {
      await page.goto(farm.origin + '/farm')
      await hydrated(page)
      // The summary reads the last state the server holds a moment after load.
      await expect(
        page.getByRole('region', { name: 'Resumo da farm' }),
      ).toContainText('Imprimindo: 1', { timeout: 30_000 })
    },
    async show(page) {
      await page.getByRole('button', { name: 'Tabela' }).click()
      await expect(
        page.getByRole('table', { name: 'Impressoras atribuídas' }),
      ).toBeVisible()
    },
  },
  {
    name: 'printer-detail',
    async open(page, farm) {
      await page.goto(`${farm.origin}/impressoras/${printerKey}`)
      await hydrated(page)
    },
  },
  {
    name: 'library',
    async open(page, farm) {
      await page.goto(farm.origin + '/biblioteca')
      await hydrated(page)
      await expect(
        page.getByRole('button', {
          name: 'Ver detalhes de Vaso visual',
          exact: true,
        }),
      ).toBeVisible()
    },
  },
  {
    name: 'network',
    async open(page, farm) {
      await page.goto(farm.origin + '/rede')
      await hydrated(page)
    },
  },
  {
    name: 'panel',
    async open(page, farm) {
      await page.goto(farm.origin + '/painel')
      await hydrated(page)
    },
  },
]

test('visual: farm, printer, library, Rede and Painel in light and dark at 390, 768 and 1280 px', async ({
  bootFarm,
}) => {
  const farm = await bootFarm({
    printers: [{ family: 'moonraker', printerKey }],
    history: true,
  })
  const page = farm.owner
  try {
    // One library item (server storage: Connector mode has no upload relay).
    const uploaded = await page.evaluate(
      async ({ farmId, name }) => {
        const mode = await fetch(`/api/farms/${farmId}/library/settings`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ storageMode: 'server' }),
        })
        if (!mode.ok) return { status: mode.status, body: await mode.text() }
        const params = new URLSearchParams({ name, title: 'Vaso visual' })
        const response = await fetch(`/api/farms/${farmId}/library?${params}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: ';FLAVOR:Marlin\nG28\nG1 X10 Y10 F3000\n',
        })
        return { status: response.status, body: await response.text() }
      },
      { farmId: farm.farmId, name: 'vaso-visual.gcode' },
    )
    expect(uploaded.status, uploaded.body).toBe(201)
    await freezeClock(page, FROZEN_INSTANT)
    await page.context().addInitScript(fixGeneratedValues)

    for (const shot of SHOTS) {
      await shot.open(page, farm)
      await settled(page, 7)
      for (const width of WIDTHS)
        for (const theme of THEMES)
          await test.step(`${shot.name} ${width}px ${theme}`, async () => {
            await page.setViewportSize({ width, height: 900 })
            await chooseTheme(page, theme)
            await shot.show?.(page)
            await settled(page, 1)
            await expect(page).toHaveScreenshot(
              `${shot.name}-${width}-${theme}.png`,
              {
                fullPage: true,
                animations: 'disabled',
                caret: 'hide',
                // Only the live camera video is masked; nothing else.
                mask: [page.locator('video')],
              },
            )
          })
    }
    farm.assertNoOutbound()
  } catch (error) {
    console.error(farm.harness.appLog())
    throw error
  }
})
