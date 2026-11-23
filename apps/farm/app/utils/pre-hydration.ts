/** Let the SSR page become usable while the client entry is still loading. */
export function asyncClientEntry(head: string): string {
  return head.replace(
    /<script type="module" src="(\/_nuxt\/[^" ]+\.js)"/g,
    '<script type="module" async src="$1"',
  )
}

export const themeScript = `try {
  var choice = localStorage.getItem('farm-theme');
  var theme = choice === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.documentElement.style.colorScheme = theme;
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue('--color-surface').trim();
} catch (_) { document.documentElement.dataset.theme = 'dark'; document.documentElement.classList.add('dark'); document.documentElement.style.colorScheme = 'dark'; }`

export const themeStyles = `
:root[data-theme="light"] { color-scheme: light; --surface: #f4f5f3; --surface-raised: #ffffff; --text: #202522; --text-muted: #4e5953; --accent: #176544; --printer-idle: #455850; --printer-printing: #175584; --printer-paused: #795000; --printer-error: #a02534; --printer-offline: #535765; --printer-stale: #694784; }
:root[data-theme="dark"] { color-scheme: dark; --surface: #181c19; --surface-raised: #242a26; --text: #e6ebe7; --text-muted: #b3bfb7; --accent: #8dd9b1; --printer-idle: #b3c9bf; --printer-printing: #9cd0ff; --printer-paused: #f2cd81; --printer-error: #ffa8ae; --printer-offline: #bfc3d2; --printer-stale: #ddbcf5; }
`
