import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { browserOptions, launchBrowser } from '../helpers/browser.ts'

const root = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')

test('browserOptions helper resolves channel chrome by default', () => {
  const origBrowser = process.env.OPENFARM_BROWSER
  const origChrome = process.env.OPENFARM_CHROME_PATH
  delete process.env.OPENFARM_BROWSER
  delete process.env.OPENFARM_CHROME_PATH
  try {
    const opts = browserOptions()
    assert.equal(opts.channel, 'chrome')
    assert.equal(opts.headless, true)
    assert.equal(opts.executablePath, undefined)
  } finally {
    if (origBrowser !== undefined) process.env.OPENFARM_BROWSER = origBrowser
    if (origChrome !== undefined) process.env.OPENFARM_CHROME_PATH = origChrome
  }
})

test('browserOptions helper uses bundled Chromium only when OPENFARM_BROWSER=bundled', () => {
  const origBrowser = process.env.OPENFARM_BROWSER
  const origChrome = process.env.OPENFARM_CHROME_PATH
  process.env.OPENFARM_BROWSER = 'bundled'
  process.env.OPENFARM_CHROME_PATH = '/custom/path'
  try {
    const opts = browserOptions()
    assert.equal(opts.channel, undefined)
    assert.equal(opts.executablePath, undefined)
    assert.equal(opts.headless, true)
  } finally {
    if (origBrowser !== undefined) process.env.OPENFARM_BROWSER = origBrowser
    else delete process.env.OPENFARM_BROWSER
    if (origChrome !== undefined) process.env.OPENFARM_CHROME_PATH = origChrome
    else delete process.env.OPENFARM_CHROME_PATH
  }
})

test('browserOptions helper uses OPENFARM_CHROME_PATH as explicit executablePath', () => {
  const origBrowser = process.env.OPENFARM_BROWSER
  const origChrome = process.env.OPENFARM_CHROME_PATH
  delete process.env.OPENFARM_BROWSER
  process.env.OPENFARM_CHROME_PATH = '/custom/chrome/bin'
  try {
    const opts = browserOptions()
    assert.equal(opts.channel, undefined)
    assert.equal(opts.executablePath, '/custom/chrome/bin')
    assert.equal(opts.headless, true)
  } finally {
    if (origBrowser !== undefined) process.env.OPENFARM_BROWSER = origBrowser
    if (origChrome !== undefined) process.env.OPENFARM_CHROME_PATH = origChrome
    else delete process.env.OPENFARM_CHROME_PATH
  }
})

test('browserOptions merges user overrides correctly', () => {
  const origBrowser = process.env.OPENFARM_BROWSER
  delete process.env.OPENFARM_BROWSER
  try {
    const opts = browserOptions({
      baseURL: 'http://127.0.0.1:3100',
      headless: false,
      timeout: 5000,
    })
    assert.equal(opts.channel, 'chrome')
    assert.equal(opts.baseURL, 'http://127.0.0.1:3100')
    assert.equal(opts.headless, false)
    assert.equal(opts.timeout, 5000)
  } finally {
    if (origBrowser !== undefined) process.env.OPENFARM_BROWSER = origBrowser
  }
})

test('all nine Playwright configs import and use browserOptions', () => {
  const expectedConfigs = [
    'playwright.config.ts',
    'playwright.farm-view.config.ts',
    'playwright.browser-device-http.config.ts',
    'playwright.setup-forms.config.ts',
    'playwright.auth-session.config.ts',
    'playwright.kobralink.config.ts',
    'playwright.printer-assignment-http.config.ts',
    'playwright.pairing-http.config.ts',
    'playwright.journey.config.ts',
  ]

  for (const configName of expectedConfigs) {
    const filePath = join(root, configName)
    const content = readFileSync(filePath, 'utf8')
    assert.match(
      content,
      /import\s+{[^}]*browserOptions[^}]*}\s+from\s+['"]\.\/tests\/helpers\/browser\.ts['"]/,
      `${configName} must import browserOptions from ./tests/helpers/browser.ts`,
    )
    assert.match(
      content,
      /\.\.\.browserOptions\(/,
      `${configName} must spread browserOptions() into use block`,
    )
  }
})

test('rg verifies no chromium.launch outside tests/helpers/browser.ts', () => {
  let output = ''
  try {
    output = execFileSync(
      'rg',
      ['-n', 'chromium\\.launch\\(', '-g', '!**/browser.ts'],
      { cwd: root, encoding: 'utf8' },
    )
  } catch (err) {
    // rg exits with 1 when no matches are found
    if (err && err.status === 1) {
      output = ''
    } else {
      throw err
    }
  }
  assert.equal(
    output.trim(),
    '',
    `Found forbidden chromium.launch calls:\n${output}`,
  )
})

test('CI workflow no longer runs playwright install', () => {
  const ciPath = join(root, '.github/workflows/ci.yml')
  const content = readFileSync(ciPath, 'utf8')
  assert.doesNotMatch(content, /playwright\s+install/)
})

test('launchBrowser runs system Chrome even when PLAYWRIGHT_BROWSERS_PATH is nonexistent', async () => {
  const origBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH
  const origBrowser = process.env.OPENFARM_BROWSER
  process.env.PLAYWRIGHT_BROWSERS_PATH = '/nonexistent'
  delete process.env.OPENFARM_BROWSER
  try {
    const browser = await launchBrowser({ headless: true })
    try {
      const version = browser.version()
      assert.ok(typeof version === 'string' && version.length > 0)
      const page = await browser.newPage()
      await page.goto('about:blank')
      const result = await page.evaluate(() => navigator.userAgent)
      assert.match(result, /Chrome/)
      await page.close()
    } finally {
      await browser.close()
    }
  } finally {
    if (origBrowsersPath !== undefined)
      process.env.PLAYWRIGHT_BROWSERS_PATH = origBrowsersPath
    else delete process.env.PLAYWRIGHT_BROWSERS_PATH
    if (origBrowser !== undefined) process.env.OPENFARM_BROWSER = origBrowser
  }
})
