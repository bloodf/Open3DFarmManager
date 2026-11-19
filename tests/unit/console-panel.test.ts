// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest'
import { renderFarmComponent } from '../../apps/farm/app/components/farm/render-farm-component.ts'
import {
  CONSOLE_HISTORY_MAX,
  CONSOLE_SCROLLBACK_LINES,
  appendEntries,
  completeCommand,
  isTemperatureChatter,
  lineProblem,
  loadHistory,
  pushHistory,
  saveHistory,
  stepHistory,
  suggestCommands,
  visibleEntries,
} from '../../apps/farm/app/components/printer-detail/console-view.ts'

const file = '../printer-detail/ConsolePanel.vue'
const base = {
  advertised: true,
  canCommand: true,
  printerKey: 'printer-a',
  commands: ['G28', 'SET_LED', 'SET_PIN', 'M105'],
}

describe('console scrollback', () => {
  it('keeps only the newest 1000 lines', () => {
    const lines = Array.from({ length: 1005 }, (_, i) => `linha ${i}`)
    const entries = appendEntries([], 'response', lines)
    expect(entries).toHaveLength(CONSOLE_SCROLLBACK_LINES)
    expect(entries[0]!.text).toBe('linha 5')
    expect(entries.at(-1)!.text).toBe('linha 1004')
    const more = appendEntries(entries, 'command', ['G28'])
    expect(more).toHaveLength(CONSOLE_SCROLLBACK_LINES)
    expect(more.at(-1)).toMatchObject({ kind: 'command', text: 'G28' })
    expect(new Set(more.map(({ id }) => id)).size).toBe(more.length)
    expect(entries).toHaveLength(CONSOLE_SCROLLBACK_LINES)
  })

  it('filters temperature chatter but never your own commands', () => {
    for (const text of [
      'ok T:200.0 /210.0 B:60.0 /60.0',
      'T:25.1 /0.0 B:24.9 /0.0 @:0 B@:0',
      'ok B:59.9 /60.0',
      'T0:200 /210',
    ])
      expect(isTemperatureChatter(text)).toBe(true)
    for (const text of ['ok', '// Klipper state: Ready', 'M105', 'Bed: ok'])
      expect(isTemperatureChatter(text)).toBe(false)
    const entries = appendEntries(
      appendEntries([], 'command', ['M105']),
      'response',
      ['ok T:200.0 /210.0 B:60.0 /60.0', 'ok'],
    )
    expect(visibleEntries(entries, true).map((e) => e.text)).toEqual([
      'M105',
      'ok',
    ])
    expect(visibleEntries(entries, false)).toHaveLength(3)
  })
})

describe('console history and autocomplete', () => {
  it('walks the history with the arrow keys', () => {
    const history = ['G28', 'M105', 'M114']
    let step = stepHistory(history, history.length, 'up')
    expect(step).toEqual({ cursor: 2, text: 'M114' })
    step = stepHistory(history, step.cursor, 'up')
    step = stepHistory(history, step.cursor, 'up')
    expect(step).toEqual({ cursor: 0, text: 'G28' })
    expect(stepHistory(history, 0, 'up')).toEqual({ cursor: 0, text: 'G28' })
    expect(stepHistory(history, 1, 'down')).toEqual({ cursor: 2, text: 'M114' })
    expect(stepHistory(history, 2, 'down')).toEqual({ cursor: 3, text: '' })
    expect(stepHistory(history, 3, 'down')).toEqual({ cursor: 3, text: '' })
    expect(stepHistory([], 0, 'up')).toEqual({ cursor: 0, text: '' })
  })

  it('bounds the history and skips repeats', () => {
    expect(pushHistory(['G28'], 'G28')).toEqual(['G28'])
    expect(pushHistory(['G28'], 'M105')).toEqual(['G28', 'M105'])
    const full = Array.from({ length: CONSOLE_HISTORY_MAX }, (_, i) => `M${i}`)
    const next = pushHistory(full, 'G28')
    expect(next).toHaveLength(CONSOLE_HISTORY_MAX)
    expect(next.at(-1)).toBe('G28')
    expect(full).toHaveLength(CONSOLE_HISTORY_MAX)
  })

  it('stores history per browser and printer, and survives bad storage', () => {
    const data = new Map<string, string>()
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
    }
    saveHistory(storage, 'a', ['G28'])
    expect(loadHistory(storage, 'a')).toEqual(['G28'])
    expect(loadHistory(storage, 'b')).toEqual([])
    data.set('openfarm.console.history.a', '{oops')
    expect(loadHistory(storage, 'a')).toEqual([])
    data.set(
      'openfarm.console.history.a',
      JSON.stringify(['G28', 7, 'M117 olá', 'M105']),
    )
    expect(loadHistory(storage, 'a')).toEqual(['G28', 'M105'])
    expect(loadHistory(undefined, 'a')).toEqual([])
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(loadHistory(broken, 'a')).toEqual([])
    expect(() => saveHistory(broken, 'a', ['G28'])).not.toThrow()
  })

  it('suggests commands from the printer help and completes with Tab', () => {
    const commands = ['G28', 'SET_LED', 'SET_PIN', 'M105']
    expect(suggestCommands('set_', commands)).toEqual(['SET_LED', 'SET_PIN'])
    expect(suggestCommands('SET_LED', commands)).toEqual([])
    expect(suggestCommands('SET_LED LED=x', commands)).toEqual([])
    expect(suggestCommands('', commands)).toEqual([])
    expect(suggestCommands('Z', commands)).toEqual([])
    expect(completeCommand(['SET_LED', 'SET_PIN'])).toBe('SET_LED ')
    expect(completeCommand([])).toBeUndefined()
  })

  it('explains an unsendable line in pt-BR', () => {
    expect(lineProblem('G28')).toBeUndefined()
    expect(lineProblem('  ')).toBe('Digite um comando.')
    expect(lineProblem('M117 olá')).toContain('ASCII')
    expect(lineProblem('G28\nM112')).toContain('única linha')
    expect(lineProblem('G'.repeat(257))).toContain('256')
  })
})

describe('ConsolePanel', () => {
  it('shows the catalog reason and no form when not advertised', async () => {
    const html = await renderFarmComponent(file, {
      ...base,
      advertised: false,
      disabledReason: 'Console desligado nesta impressora.',
    })
    expect(html).toContain('Console desligado nesta impressora.')
    expect(html).not.toContain('<form')
    expect(html).not.toContain('<input')
    const fallback = await renderFarmComponent(file, {
      ...base,
      advertised: false,
    })
    expect(fallback).toContain('Esta impressora não anuncia este recurso.')
  })

  it('disables the form with the reason when commands are not allowed', async () => {
    const html = await renderFarmComponent(file, {
      ...base,
      canCommand: false,
      disabledReason: 'Somente administradores.',
    })
    expect(html).toContain('Somente administradores.')
    expect(html).toContain('id="console-line"')
    expect(html).toMatch(/<input[^>]*id="console-line"[^>]*disabled/)
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/)
    expect(html).toContain('aria-describedby="console-reason"')
  })

  it('offers an accessible, labelled console when allowed', async () => {
    const html = await renderFarmComponent(file, base)
    expect(html).toContain('<h2 id="console-title">Console G-code</h2>')
    expect(html).toContain('<label for="console-line">Comando G-code</label>')
    expect(html).toContain('role="log"')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('Ocultar leituras de temperatura')
    expect(html).toContain('Limpar console')
    expect(html).not.toMatch(/<input[^>]*id="console-line"[^>]*disabled/)
    expect(html).not.toContain('console-printing')
  })

  it('says only the tuning allow-list is accepted while printing', async () => {
    const html = await renderFarmComponent(file, { ...base, printing: true })
    expect(html).toContain('Durante a impressão, só são aceitos')
    expect(html).toContain('M220')
    expect(html).toContain('aria-describedby="console-printing"')
  })

  it('shows response lines and hides temperature chatter by default', async () => {
    const html = await renderFarmComponent(file, {
      ...base,
      responses: [
        { seq: 1, lines: ['ok T:200.0 /210.0 B:60.0 /60.0', 'hello console'] },
        { seq: 2, lines: ['// Klipper pronto'] },
      ],
    })
    expect(html).toContain('hello console')
    expect(html).toContain('// Klipper pronto')
    expect(html).not.toContain('T:200.0')
  })

  it('stays within the scrollback when many lines arrive', async () => {
    const lines = Array.from({ length: 1200 }, (_, i) => `linha ${i}`)
    const html = await renderFarmComponent(file, {
      ...base,
      responses: [{ seq: 1, lines }],
    })
    expect(html).not.toContain('linha 199<')
    expect(html).toContain('linha 200<')
    expect(html).toContain('linha 1199<')
  })
})
