import { chromium, type Browser, type LaunchOptions } from '@playwright/test'

export type BrowserOptions = LaunchOptions & {
  browserName?: 'chromium'
}

/**
 * Resolves browser options:
 * - bundled Chromium only when OPENFARM_BROWSER=bundled
 * - OPENFARM_CHROME_PATH as explicit executablePath
 * - channel: 'chrome' by default
 * - headless: true by default, no GPU or audio/camera flags required
 */
export function browserOptions<T extends object = BrowserOptions>(
  overrides?: T,
): BrowserOptions & T {
  const options: BrowserOptions = {
    headless: true,
  }

  if (process.env.OPENFARM_BROWSER === 'bundled') {
    // Bundled Chromium only: leave channel and executablePath unset
  } else if (
    process.env.OPENFARM_CHROME_PATH &&
    process.env.OPENFARM_CHROME_PATH.trim() !== ''
  ) {
    options.executablePath = process.env.OPENFARM_CHROME_PATH
  } else {
    options.channel = 'chrome'
  }

  return Object.assign(options, overrides) as BrowserOptions & T
}

/**
 * Launches the browser using the configured OpenFarm options.
 */
export async function launchBrowser(options?: LaunchOptions): Promise<Browser> {
  const resolved = browserOptions(options)
  const launchOpts: LaunchOptions = { ...resolved }
  delete (launchOpts as { browserName?: unknown }).browserName
  return chromium.launch(launchOpts)
}

/**
 * Runs `use` against a browser whose process is force-killed afterwards.
 *
 * Chrome's graceful shutdown can stall on a loaded host until its own
 * teardown watchdog and then Playwright's 30 s kill deadline fire, so a test
 * that only needs the browser while it runs would spend most of its budget
 * closing it. Killing the launched server skips that wait and still removes
 * the process group and its temporary profile.
 */
export async function withBrowser<T>(
  options: LaunchOptions,
  use: (browser: Browser) => Promise<T>,
): Promise<T> {
  const launchOpts: LaunchOptions = { ...browserOptions(options) }
  delete (launchOpts as { browserName?: unknown }).browserName
  const server = await chromium.launchServer(launchOpts)
  try {
    const browser = await chromium.connect(server.wsEndpoint())
    try {
      return await use(browser)
    } finally {
      await browser.close()
    }
  } finally {
    await server.kill()
  }
}

export const launchChromium = launchBrowser
export type { Browser, LaunchOptions }
