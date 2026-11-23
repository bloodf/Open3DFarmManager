// Theme toggle. Without JavaScript the page follows the system preference.
;(() => {
  const STORAGE_KEY = 'openfarm-site-theme'
  const root = document.documentElement
  const button = document.querySelector('[data-theme-toggle]')
  if (!button) return

  const systemDark = window.matchMedia('(prefers-color-scheme: dark)')
  const current = () =>
    root.dataset.theme || (systemDark.matches ? 'dark' : 'light')
  const sync = () =>
    button.setAttribute('aria-pressed', String(current() === 'dark'))

  button.hidden = false
  sync()

  button.addEventListener('click', () => {
    const next = current() === 'dark' ? 'light' : 'dark'
    root.dataset.theme = next
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch (error) {
      // Storage can be blocked; the choice then lasts for this visit only.
    }
    sync()
  })

  systemDark.addEventListener('change', sync)
})()
