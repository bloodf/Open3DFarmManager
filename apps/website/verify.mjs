#!/usr/bin/env node
// Evidence command: node apps/website/verify.mjs
// Builds the site (twice, to prove determinism), opens every built page over
// file:// URLs in Chromium, and checks it at desktop and 360px widths in light
// and dark: console/page errors, external requests, overflow, keyboard focus,
// reduced motion, theme toggle, screenshot attribution and axe (WCAG A/AA).
// Screenshots and report.json go outside the repository, in a directory that
// is unique to each invocation (or OPENFARM_WEBSITE_SHOTS when set), and each
// invocation builds into its own private directory, so concurrent runs never
// share files. No server is started.
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { MARKER } from './build.mjs'
import { prepareEvidenceDir } from './lib/evidence-dir.mjs'
import { isInside, listFiles, sha256 } from './lib/files.mjs'
import {
  backgroundLuminance,
  describeFocus,
  inspectOverflow,
  inspectStructure,
  longestMotion,
  tagFocusables,
} from './lib/page-checks.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const buildScript = path.join(here, 'build.mjs')
const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'mobile-360', width: 360, height: 780 },
]
const SCHEMES = ['light', 'dark']
const AXE_TAGS = [
  'wcag2a',
  'wcag2aa',
  'wcag21a',
  'wcag21aa',
  'wcag22aa',
  'best-practice',
]

const failures = []
const passes = []
const record = (ok, name, detail = []) => {
  const lines = [detail].flat().filter(Boolean)
  if (ok) passes.push(name)
  else failures.push({ name, detail: lines })
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}\n`)
  for (const line of lines) if (!ok) process.stdout.write(`       ${line}\n`)
}

async function loadBrowserTools() {
  try {
    const [{ chromium }, axe] = await Promise.all([
      import('playwright-core'),
      import('@axe-core/playwright'),
    ])
    return { chromium, AxeBuilder: axe.default ?? axe.AxeBuilder }
  } catch (error) {
    throw new Error(
      `Playwright or axe is not installed (${error.message}). Run "npm ci --ignore-scripts" at the repository root.`,
    )
  }
}

function runBuild(siteDir) {
  const result = spawnSync(process.execPath, [buildScript, '--out', siteDir], {
    encoding: 'utf8',
  })
  if (result.status !== 0)
    throw new Error(`build failed:\n${result.stderr || result.stdout}`)
}

async function readManifest(siteDir) {
  return JSON.parse(await readFile(path.join(siteDir, MARKER), 'utf8'))
}

async function htmlPages(siteDir) {
  return (await listFiles(siteDir)).filter((file) => file.endsWith('.html'))
}

/** Parse docs/images/README.md into { file -> { route, viewport } } plus commit and date. */
async function readScreenshotProvenance() {
  const source = await readFile(
    path.join(repoRoot, 'docs', 'images', 'README.md'),
    'utf8',
  )
  const rows = {}
  for (const match of source.matchAll(
    /\|\s*`([\w.-]+\.png)`\s*\|\s*`([^`]+)`\s*\|\s*([\d]+ × [\d]+)\s*\|/g,
  )) {
    rows[match[1]] = { route: match[2], viewport: match[3] }
  }
  const commit = source.match(/commit `([0-9a-f]{40})`/)?.[1]
  const date = source.match(/em (\d+ de \w+ de \d{4})/)?.[1]
  return { rows, commit, date }
}

async function checkScreenshotAttribution(page, siteDir, provenance, label) {
  const figures = await page.evaluate(() =>
    [...document.querySelectorAll('img[src*="assets/screenshots/"]')].map(
      (img) => ({
        file: img.getAttribute('src').split('/').pop(),
        caption:
          img
            .closest('figure')
            ?.querySelector('figcaption')
            ?.textContent.replace(/\s+/g, ' ')
            .trim() ?? '',
        link:
          img
            .closest('figure')
            ?.querySelector('figcaption a')
            ?.getAttribute('href') ?? '',
      }),
    ),
  )
  const problems = []
  for (const { file, caption, link } of figures) {
    const known = provenance.rows[file]
    if (!known) {
      problems.push(`${file} is not listed in docs/images/README.md`)
      continue
    }
    const expected = [
      ['Captura real', 'real capture label'],
      [`rota ${known.route}`, 'route'],
      [known.viewport, 'viewport'],
      [provenance.date, 'capture date'],
      [provenance.commit.slice(0, 7), 'commit'],
    ]
    for (const [text, what] of expected) {
      if (!caption.includes(text))
        problems.push(`${file}: caption lacks ${what} ("${text}")`)
    }
    if (!link.endsWith('docs/images/README.md'))
      problems.push(`${file}: caption does not link the provenance README`)
    const built = await sha256(
      path.join(siteDir, 'assets', 'screenshots', file),
    )
    const original = await sha256(path.join(repoRoot, 'docs', 'images', file))
    if (built !== original)
      problems.push(`${file}: bytes differ from docs/images/${file}`)
  }
  record(
    problems.length === 0,
    `${label} screenshot attribution (${figures.length} figures)`,
    problems,
  )
}

function attachGuards(page, siteDir, issues) {
  const allowed = (url) =>
    url.startsWith('data:') ||
    url.startsWith('blob:') ||
    url === 'about:blank' ||
    (url.startsWith('file://') &&
      isInside(siteDir, fileURLToPath(url.split('#')[0])))
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type()))
      issues.push(`console ${message.type()}: ${message.text()}`)
  })
  page.on('pageerror', (error) => issues.push(`page error: ${error.message}`))
  page.on('requestfailed', (request) =>
    issues.push(`request failed: ${request.url()}`),
  )
  page.on('request', (request) => {
    if (!allowed(request.url()))
      issues.push(`request outside the built site: ${request.url()}`)
  })
}

async function checkKeyboard(page, label) {
  const problems = []
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Tab')
  const first = await page.evaluate(
    () => document.activeElement?.className ?? '',
  )
  if (!String(first).includes('skip-link'))
    problems.push(`first Tab stop is not the skip link (got "${first}")`)
  else {
    const skip = await page.evaluate(describeFocus)
    if (!skip?.visibleFocus || !skip.inView)
      problems.push('skip link is not visibly focused')
    await page.keyboard.press('Enter')
    const target = await page.evaluate(() => document.activeElement?.id)
    if (target !== 'conteudo')
      problems.push(`skip link left focus on "${target}" instead of #conteudo`)
  }
  await page.reload({ waitUntil: 'load' })
  const expected = await page.evaluate(tagFocusables)
  const visited = []
  for (let i = 0; i < expected.length; i += 1) {
    await page.keyboard.press('Tab')
    let focus = await page.evaluate(describeFocus)
    // Smooth scrolling is animated, so give the focused element time to arrive.
    for (let wait = 0; focus && !focus.inView && wait < 20; wait += 1) {
      await page.waitForTimeout(50)
      focus = await page.evaluate(describeFocus)
    }
    if (!focus) {
      problems.push(`Tab stop ${i + 1} left focus on the document`)
      break
    }
    if (focus.id === 'conteudo') continue
    if (!focus.visibleFocus)
      problems.push(
        `no visible focus on ${expected[focus.tag]?.label ?? focus.tag}`,
      )
    if (!focus.inView)
      problems.push(
        `focused element off screen: ${expected[focus.tag]?.label ?? focus.tag}`,
      )
    visited.push(focus.tag)
  }
  const missed = expected.filter(
    (item) => !visited.includes(String(item.index)),
  )
  if (missed.length > 0 && visited.length > 0) {
    problems.push(
      `Tab order skipped: ${missed
        .slice(0, 4)
        .map((m) => m.label)
        .join('; ')}`,
    )
  }
  if (!visited.length) problems.push('no focusable elements reached by Tab')
  const sorted = [...visited]
    .map(Number)
    .every((n, i, all) => i === 0 || n >= all[i - 1])
  if (!sorted) problems.push('Tab order differs from DOM order')
  record(
    problems.length === 0,
    `${label} keyboard and focus (${expected.length} stops)`,
    problems.slice(0, 8),
  )

  // Disclosure widgets open from the keyboard.
  const summary = page.locator('summary').first()
  if (await summary.count()) {
    await summary.focus()
    await page.keyboard.press('Enter')
    const open = await summary.evaluate((el) => el.parentElement.open)
    record(open, `${label} <summary> opens with Enter`)
  }
}

async function runAxe(AxeBuilder, page, label) {
  await page.evaluate(() =>
    document.querySelectorAll('details').forEach((d) => (d.open = true)),
  )
  const { violations } = await new AxeBuilder({ page })
    // axe preloads stylesheets with XHR, which Chromium blocks on file://.
    .options({ preload: false })
    .withTags(AXE_TAGS)
    .analyze()
  const detail = violations.flatMap((v) => [
    `${v.id} (${v.impact}): ${v.help}`,
    ...v.nodes
      .slice(0, 3)
      .map(
        (n) =>
          `  ${n.target.join(' ')} — ${n.failureSummary?.split('\n')[1]?.trim() ?? ''}`,
      ),
  ])
  record(
    violations.length === 0,
    `${label} axe ${AXE_TAGS.slice(0, 5).join('+')}`,
    detail,
  )
}

async function verifyPage(
  browser,
  AxeBuilder,
  file,
  { siteDir, shotsDir, provenance },
) {
  const url = pathToFileURL(path.join(siteDir, file)).href
  const slug = file.replace(/\.html$/, '').replace(/[\\/]/g, '-')
  const pageLabel = `[${file}]`
  for (const viewport of VIEWPORTS) {
    for (const scheme of SCHEMES) {
      const label = `${pageLabel} ${viewport.name} ${scheme}`
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        colorScheme: scheme,
        reducedMotion: 'no-preference',
        deviceScaleFactor: 1,
      })
      const page = await context.newPage()
      page.setDefaultTimeout(15_000)
      const issues = []
      attachGuards(page, siteDir, issues)
      await page.goto(url, { waitUntil: 'load' })
      await page.evaluate(() => document.fonts.ready)

      const luminance = await page.evaluate(backgroundLuminance)
      record(
        scheme === 'light' ? luminance > 0.5 : luminance < 0.1,
        `${label} theme applied (bg luminance ${luminance.toFixed(3)})`,
      )
      record(
        (await page.evaluate(inspectStructure)).length === 0,
        `${label} semantic structure`,
        await page.evaluate(inspectStructure),
      )
      const overflow = await page.evaluate(inspectOverflow)
      record(overflow.length === 0, `${label} no horizontal overflow`, overflow)
      if (viewport.name === 'desktop' && scheme === 'light')
        await checkScreenshotAttribution(page, siteDir, provenance, label)

      await page.screenshot({
        path: path.join(shotsDir, `${slug}-${viewport.name}-${scheme}.png`),
        fullPage: true,
      })
      await checkKeyboard(page, label)
      await runAxe(AxeBuilder, page, label)
      record(
        issues.length === 0,
        `${label} no console errors, page errors or external requests`,
        issues,
      )
      await context.close()
    }
  }
  await verifyReducedMotion(browser, url, pageLabel)
  await verifyThemeToggle(browser, AxeBuilder, siteDir, url, pageLabel)
}

async function verifyReducedMotion(browser, url, pageLabel) {
  const context = await browser.newContext({
    reducedMotion: 'reduce',
    viewport: { width: 1280, height: 800 },
  })
  const page = await context.newPage()
  await page.goto(url, { waitUntil: 'load' })
  const { longest, scrollBehavior } = await page.evaluate(longestMotion)
  record(
    longest === 0 && scrollBehavior !== 'smooth',
    `${pageLabel} reduced motion removes animation (longest ${longest}s, scroll ${scrollBehavior})`,
  )
  await context.close()
}

async function verifyThemeToggle(browser, AxeBuilder, siteDir, url, pageLabel) {
  const label = `${pageLabel} theme toggle`
  const context = await browser.newContext({
    colorScheme: 'light',
    viewport: { width: 1280, height: 800 },
  })
  const page = await context.newPage()
  const issues = []
  attachGuards(page, siteDir, issues)
  await page.goto(url, { waitUntil: 'load' })
  const toggle = page.locator('[data-theme-toggle]')
  const problems = []
  if (!(await toggle.isVisible()))
    problems.push('toggle is not visible with JavaScript on')
  else {
    await toggle.click()
    if ((await page.locator('html').getAttribute('data-theme')) !== 'dark')
      problems.push('click did not set data-theme=dark')
    if ((await toggle.getAttribute('aria-pressed')) !== 'true')
      problems.push('aria-pressed not true in dark')
    if ((await page.evaluate(backgroundLuminance)) >= 0.1)
      problems.push('page did not turn dark')
    await runAxe(AxeBuilder, page, `${label} (dark via toggle)`)
    await page.reload({ waitUntil: 'load' })
    if ((await page.locator('html').getAttribute('data-theme')) !== 'dark')
      problems.push('choice not remembered after reload')
    await toggle.click()
    if ((await page.locator('html').getAttribute('data-theme')) !== 'light')
      problems.push('second click did not return to light')
  }
  record(problems.length === 0 && issues.length === 0, label, [
    ...problems,
    ...issues,
  ])
  await context.close()
}

async function main() {
  const shotsDir = await prepareEvidenceDir({
    override: process.env.OPENFARM_WEBSITE_SHOTS,
    tmpBase: os.tmpdir(),
    repoRoot,
  })
  process.stdout.write(`Evidence directory: ${shotsDir}\n`)
  // Private build directory owned by this invocation; removed in `finally`.
  const buildRoot = await mkdtemp(
    path.join(path.resolve(os.tmpdir()), 'openfarm-website-build-'),
  )
  const siteDir = path.join(buildRoot, 'site')
  try {
    await verifySite({ shotsDir, siteDir })
  } finally {
    await rm(buildRoot, { recursive: true, force: true })
  }
}

async function verifySite({ shotsDir, siteDir }) {
  const { chromium, AxeBuilder } = await loadBrowserTools()

  runBuild(siteDir)
  const first = await readManifest(siteDir)
  runBuild(siteDir)
  const second = await readManifest(siteDir)
  record(
    JSON.stringify(first) === JSON.stringify(second),
    `build is deterministic (${Object.keys(first).length} files)`,
  )

  const pages = await htmlPages(siteDir)
  record(
    pages.length > 0,
    `found ${pages.length} built page(s): ${pages.join(', ')}`,
  )
  const provenance = await readScreenshotProvenance()
  record(
    Object.keys(provenance.rows).length > 0 &&
      Boolean(provenance.commit && provenance.date),
    'docs/images/README.md provenance parsed',
  )

  const browser = await chromium.launch()
  try {
    for (const file of pages)
      await verifyPage(browser, AxeBuilder, file, {
        siteDir,
        shotsDir,
        provenance,
      })
  } finally {
    await browser.close()
  }

  const report = {
    passed: passes.length,
    failed: failures.length,
    failures,
    screenshots: shotsDir,
  }
  await writeFile(
    path.join(shotsDir, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  )
  process.stdout.write(
    `\n${passes.length} checks passed, ${failures.length} failed\nScreenshots and report: ${shotsDir}\n`,
  )
  process.exitCode = failures.length === 0 ? 0 : 1
}

main().catch((error) => {
  process.stderr.write(`verify failed: ${error.message}\n`)
  process.exitCode = 1
})
