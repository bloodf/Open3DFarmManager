import { afterEach, describe, expect, it, vi } from 'vitest'
import { createShellShortcuts } from '../../apps/farm/app/utils/shell-shortcuts'

afterEach(() => vi.unstubAllGlobals())

function fixture() {
  const run = vi.fn()
  const handle = createShellShortcuts(run)
  class ElementFixture {
    constructor(private readonly selector: string) {}
    matches(selectors: string) {
      return selectors.split(', ').includes(this.selector)
    }
  }
  vi.stubGlobal('Element', ElementFixture)
  let timeStamp = 0
  type PressOverrides = Partial<Omit<KeyboardEvent, 'composedPath'>> & {
    composedPath?: () => readonly unknown[]
  }
  function press(key: string, overrides: PressOverrides = {}) {
    const event = {
      key,
      timeStamp: (timeStamp += 100),
      composedPath: () => [],
      preventDefault: vi.fn(),
      ...overrides,
    } as unknown as KeyboardEvent
    handle(event)
    return event.preventDefault
  }
  return { run, press, ElementFixture }
}

describe('atalhos do shell', () => {
  it('busca, abre ajuda e navega pelas duas sequências', () => {
    const { run, press } = fixture()
    expect(press('/')).toHaveBeenCalledOnce()
    expect(press('?', { shiftKey: true })).toHaveBeenCalledOnce()
    expect(press('g')).not.toHaveBeenCalled()
    expect(press('f')).toHaveBeenCalledOnce()
    press('g')
    press('b')
    expect(run.mock.calls).toEqual([
      ['search'],
      ['help'],
      ['farm'],
      ['library'],
    ])
  })

  it.each([
    'input',
    'textarea',
    'select',
    '[contenteditable]',
    '[role="textbox"]',
    '[role="combobox"]',
    'dialog[open]',
  ])('ignora teclas dentro de %s, inclusive em descendentes', (selector) => {
    const { run, press, ElementFixture } = fixture()
    const inside = {
      composedPath: () => [
        new ElementFixture('span'),
        new ElementFixture(selector),
      ],
    }
    press('g')
    expect(press('f', inside)).not.toHaveBeenCalled()
    press('b')
    press('/', inside)
    press('?', inside)
    press('g', inside)
    press('f')
    expect(run).not.toHaveBeenCalled()
  })

  it('descarta sequências expiradas, interrompidas e eventos modificados', () => {
    const { run, press } = fixture()
    press('g')
    press('f', { timeStamp: 1200 })
    press('g')
    press('x')
    press('b')
    press('/', { ctrlKey: true })
    press('/', { metaKey: true })
    press('/', { altKey: true })
    press('?', { isComposing: true })
    press('?', { repeat: true })
    press('?', { defaultPrevented: true })
    expect(run).not.toHaveBeenCalled()
  })
})
