import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import {
  fits,
  prepare,
  scenarios,
  themes,
  viewports,
  violations,
  type Scenario,
} from '../helpers/farm-evidence.ts'

// Evidence capture that records instead of asserting, so the very same states
// can be captured on the pre-polish base and on the polished page. It uses the
// same mocked /api routes as polish-farm.spec.ts; nothing leaves loopback.
// Per state it writes <state>.png and <state>.axe.json outside the repository,
// plus axe-summary.json for the whole run.
const awaited: Record<Scenario, RegExp> = {
  populated: /\/api\/farms\/[^/]+\/printers\?/,
  empty: /\/api\/farms\/[^/]+\/printers\?/,
  'no-farms': /\/api\/farms\?/,
  loading: /\/api\/farms\/[^/]+\/printers\?/,
  'sign-in': /\/api\/auth\/me/,
  error: /\/api\/auth\/me/,
}

async function waitForState(page: Page, scenario: Scenario) {
  const pattern = awaited[scenario]
  // The loading scenario never answers, so its request is the signal.
  if (scenario === 'loading') await page.waitForRequest(pattern)
  else await page.waitForResponse((response) => pattern.test(response.url()))
  await expect(
    page.getByRole('heading', { level: 1, name: 'Minha farm', exact: true }),
  ).toBeVisible()
  // Let the state render; motion is reduced so nothing animates afterwards.
  await page.waitForTimeout(750)
}

test('capture farm screen states with axe results', async ({
  page,
}, testInfo) => {
  const dir =
    process.env.POLISH_FARM_SHOTS_DIR ??
    (await mkdtemp(join(tmpdir(), 'openfarm-shots-')))
  await mkdir(dir, { recursive: true })
  testInfo.setTimeout(300_000)
  const summary: Record<string, unknown> = {}
  for (const scenario of scenarios)
    for (const viewport of viewports)
      for (const theme of themes) {
        const name = `${scenario}-${viewport.name}-${theme}`
        await page.unrouteAll({ behavior: 'ignoreErrors' })
        const waiting = waitForState(page, scenario)
        await prepare(page, scenario, viewport, theme)
        await waiting
        const found = await violations(page)
        const entry = { fitsViewport: await fits(page), violations: found }
        summary[name] = {
          fitsViewport: entry.fitsViewport,
          violationIds: found.map((violation) => violation.id),
        }
        await writeFile(
          join(dir, `${name}.axe.json`),
          `${JSON.stringify(entry, null, 2)}\n`,
        )
        const path = join(dir, `${name}.png`)
        await page.screenshot({ path, fullPage: true })
        expect((await stat(path)).size).toBeGreaterThan(0)
      }
  await writeFile(
    join(dir, 'axe-summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
  )
})
