type Shortcut = 'search' | 'farm' | 'library' | 'help'

export function createShellShortcuts(run: (shortcut: Shortcut) => void) {
  let prefixAt: number | undefined

  return (event: KeyboardEvent) => {
    const prefix = prefixAt
    prefixAt = undefined

    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.repeat ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event
        .composedPath()
        .some(
          (target) =>
            target instanceof Element &&
            target.matches(
              'input, textarea, select, [contenteditable], [role="textbox"], [role="combobox"], dialog[open]',
            ),
        )
    )
      return

    const key = event.key
    if (key === 'g') {
      prefixAt = event.timeStamp
      return
    }

    let shortcut: Shortcut | undefined
    if (key === '/') shortcut = 'search'
    if (key === '?') shortcut = 'help'
    if (prefix !== undefined && event.timeStamp - prefix <= 1000) {
      if (key === 'f') shortcut = 'farm'
      if (key === 'b') shortcut = 'library'
    }

    if (shortcut) {
      event.preventDefault()
      run(shortcut)
    }
  }
}
