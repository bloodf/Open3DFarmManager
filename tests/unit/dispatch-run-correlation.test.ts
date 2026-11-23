// spec-derived, not captured — https://moonraker.readthedocs.io/en/latest/external_api/printer/
import { describe, expect, test, vi } from 'vitest'
import type { PrinterState } from '@open3dfarmmanager/farm-protocol'
import { createLibraryJobLinks } from '../../packages/connector/src/runtime/library-job-links.ts'
import { sendLibraryReplay } from '../../apps/farm/app/utils/replay-live.ts'

const sha256 = 'a'.repeat(64)
const observed = (
  observedAt: number,
  state: PrinterState['state'],
  fields: Partial<PrinterState> = {},
): PrinterState => ({ printerKey: 'mock', observedAt, state, ...fields })
const filename = 'part.gcode'
const completed = (endedAt: number) => ({
  filename,
  outcome: 'completed' as const,
  endedAt,
})

describe('library dispatch run correlation', () => {
  test('a new observed run links once, ignoring stale and repeated previous observations', () => {
    const links = createLibraryJobLinks()
    links.attach(observed(100, 'idle', { lastJob: completed(90) }))
    links.remember('mock', { name: filename, sha256 }, 120)
    links.attach(observed(119, 'printing', { filename: 'old.gcode' }))
    links.attach(observed(130, 'printing', { filename }))
    expect(
      links.attach(
        observed(140, 'paused', { filename, lastJob: completed(90) }),
      ).lastJob,
    ).toEqual(completed(90))
    expect(
      links.attach(observed(175, 'idle', { lastJob: completed(170) })).lastJob,
    ).toEqual({ ...completed(170), sha256 })
    expect(
      links.attach(observed(180, 'idle', { lastJob: completed(170) })).lastJob
        ?.sha256,
    ).toBe(sha256)
    links.attach(observed(200, 'printing', { filename }))
    expect(
      links.attach(observed(230, 'idle', { lastJob: completed(220) })).lastJob
        ?.sha256,
    ).toBeUndefined()
  })

  test('another active file invalidates a pending match, including a later manual run of the selected file', () => {
    const links = createLibraryJobLinks()
    links.remember('mock', { name: filename, sha256 }, 100)
    links.attach(observed(120, 'printing', { filename: 'manual.gcode' }))
    links.attach(observed(150, 'printing', { filename }))
    expect(
      links.attach(observed(180, 'idle', { lastJob: completed(170) })).lastJob
        ?.sha256,
    ).toBeUndefined()
  })

  test('a run with no observed matching active file is not linked', () => {
    const links = createLibraryJobLinks()
    links.remember('mock', { name: filename, sha256 }, 100)
    links.attach(observed(110, 'printing'))
    expect(
      links.attach(observed(130, 'idle', { lastJob: completed(120) })).lastJob
        ?.sha256,
    ).toBeUndefined()
  })
})

describe('browser dispatch', () => {
  test('a stale selection during WebRTC negotiation sends nothing', async () => {
    let current = true
    const session = {
      issueControlCommand: vi.fn(),
      close: vi.fn(),
      dispose: vi.fn(async () => {}),
    }
    const result = await sendLibraryReplay(
      async () => {
        current = false
        return session
      },
      { sha256 },
      () => current,
    )
    expect(result).toEqual({ outcome: 'not-sent', code: 'stale-selection' })
    expect(session.issueControlCommand).not.toHaveBeenCalled()
    expect(session.close).toHaveBeenCalledOnce()
  })

  test('unavailable WebRTC never sends a command', async () => {
    const connect = vi.fn(async () => {
      throw new Error('no connection')
    })
    expect(await sendLibraryReplay(connect, { sha256 })).toEqual({
      outcome: 'not-sent',
    })
    expect(connect).toHaveBeenCalledTimes(3)
  })

  test('a lost acknowledgement is uncertain after one issue', async () => {
    const issueControlCommand = vi.fn(async () => {
      throw new Error('reply lost')
    })
    const connect = vi.fn(async () => ({
      issueControlCommand,
      close() {},
      async dispose() {},
    }))
    expect(await sendLibraryReplay(connect, { sha256 })).toEqual({
      outcome: 'outcome-unknown',
    })
    expect(issueControlCommand).toHaveBeenCalledExactlyOnceWith(
      'start_library_print',
      { sha256 },
    )
    expect(connect).toHaveBeenCalledOnce()
  })
})
