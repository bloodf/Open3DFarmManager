try {
  var saved = localStorage.getItem('openfarm-site-theme')
  if (saved === 'light' || saved === 'dark') {
    document.documentElement.dataset.theme = saved
  }
} catch (error) {
  // Storage can be blocked; the system preference still applies.
}
