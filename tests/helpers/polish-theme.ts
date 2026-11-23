import type { Page } from '@playwright/test'

const prepared = new WeakSet<Page>()

export async function setPolishTheme(page: Page, theme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
  if (prepared.has(page)) return
  // The real shell uses the saved preference. Read the emulated scheme on
  // every navigation so screenshot loops can switch themes on the same page.
  await page.addInitScript(() => {
    const theme = matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'
    localStorage.setItem('farm-theme', theme)
  })
  prepared.add(page)
}
