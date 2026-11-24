// spec-derived, not captured: https://moonraker.readthedocs.io/en/latest/web_api/#job-queue-apis
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openQueueCollectionJournal } from '../../packages/connector/src/control/queue-collection-journal.ts'

describe('durable collection journal', () => {
  it('holds each printer after restart and ignores repeated completion reports', () => {
    const dir = mkdtempSync(join(tmpdir(), 'queue-collection-'))
    try {
      const path = join(dir, 'journal.json')
      const first = openQueueCollectionJournal(path)
      first.complete('printer', 'attempt-1')
      first.complete('printer', 'attempt-1')
      expect(first.blocked('other')).toBe(false)
      const restarted = openQueueCollectionJournal(path)
      expect(restarted.blocked('printer')).toBe(true)
      restarted.confirm('printer', 'attempt-1')
      restarted.complete('printer', 'attempt-1')
      expect(openQueueCollectionJournal(path).blocked('printer')).toBe(false)
      restarted.complete('printer', 'attempt-2')
      restarted.confirm('printer', 'attempt-1')
      expect(openQueueCollectionJournal(path).blocked('printer')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('refuses a corrupt journal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'queue-collection-'))
    try {
      const path = join(dir, 'journal.json')
      writeFileSync(path, '{')
      expect(() => openQueueCollectionJournal(path)).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('notifies only after a confirmation changes durable collection state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'queue-collection-'))
    try {
      const path = join(dir, 'journal.json')
      const released: [string, readonly string[]][] = []
      const journal = openQueueCollectionJournal(path, (key) => {
        released.push([key, openQueueCollectionJournal(path).awaiting(key)])
      })
      journal.complete('printer', '10')
      journal.complete('printer', '20')
      expect(journal.confirmThrough('printer', 9)).toBe(0)
      expect(() => journal.confirm('printer', 'unknown')).toThrow()
      expect(released).toEqual([])
      expect(journal.confirmThrough('printer', 10)).toBe(1)
      expect(journal.confirmThrough('printer', 10)).toBe(0)
      journal.confirm('printer', '20')
      journal.confirm('printer', '20')
      journal.confirmInitial('other')
      expect(() => journal.confirmInitial('other')).toThrow()
      expect(released).toEqual([
        ['printer', ['20']],
        ['printer', []],
        ['other', []],
      ])
      journal.complete('printer', '30')
      rmSync(path)
      mkdirSync(path)
      expect(() => journal.confirmThrough('printer', 30)).toThrow()
      expect(released).toHaveLength(3)
      expect(() => journal.blocked('printer')).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
