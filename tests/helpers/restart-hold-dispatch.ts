import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HOLD_AUDIT_FILE } from '../../packages/connector/src/control/command-journal.ts'
import type { ExtendedControlAction } from '../../packages/farm-protocol/src/control-actions.ts'
import {
  createV2Authority,
  nodeSigner,
  openV2Dispatch,
} from './command-v2-dispatch.ts'

const SAVE = {
  path: 'printer.cfg',
  base_sha256: 'a'.repeat(64),
  sha256: 'b'.repeat(64),
  restart: true,
}
export const argsOf = (action: ExtendedControlAction) =>
  action === 'config_write' ? SAVE : {}

export async function dispatcherFixture(
  t: TestContext,
  role: 'owner' | 'admin' | 'operator' = 'admin',
) {
  const authority = await createV2Authority(await nodeSigner())
  const directory = mkdtempSync(join(tmpdir(), 'rv-947-dispatch-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const actions: ExtendedControlAction[] = [
    'pause',
    'firmware_restart',
    'emergency_stop',
    ...(role === 'operator' ? [] : (['config_write', 'clear_hold'] as const)),
  ]
  const sent: ExtendedControlAction[] = []
  const printer = {
    ready: true,
    state: 'idle' as 'idle' | 'printing' | 'paused',
    /** The next reads that report Klippy not ready. */
    notReadyReads: 0,
    reads: 0,
    /** The next read never answers; only an abort ends it. */
    hang: false,
    reading: () => {},
    closing: () => {},
    holdPrepareOpen: undefined as Promise<void> | undefined,
    holdCloseOpen: undefined as Promise<void> | undefined,
  }
  const open = async (now: number) => {
    const d = await openV2Dispatch(authority, {
      directory,
      now,
      capability: { actions, role },
      // No origin is dialled; the driver below is entirely fake.
      loopback: {
        origin: 'http://127.0.0.1:7125',
        driver({ clock, observe }) {
          let sequence = 0
          let current: ExtendedControlAction | undefined
          let ready = true
          const observation = () => {
            const mono = clock.monotonicNow()
            return {
              assignmentId: authority.ids.assignment_id,
              printerKey: authority.printerKey,
              connectionGeneration: 1,
              sequence: ++sequence,
              ready,
              printState: printer.state,
              readyObservedMono: mono,
              printStateObservedMono: mono,
              receivedMono: mono,
            }
          }
          return {
            async detect() {},
            // The driver never offers `clear_hold`: it is the Connector's own.
            controls: () => actions.filter((a) => a !== 'clear_hold'),
            async prepare({ binding, signal }) {
              printer.reads++
              if (printer.hang) {
                printer.hang = false
                printer.reading()
                await (printer.holdPrepareOpen ??
                  new Promise((_, reject) =>
                    signal.addEventListener('abort', () =>
                      reject(new Error('aborted')),
                    ),
                  ))
              }
              current = undefined
              ready = printer.ready && printer.notReadyReads === 0
              if (printer.notReadyReads) printer.notReadyReads--
              observe(binding, observation())
              return { connectionGeneration: 1 }
            },
            async closeAttempt() {
              printer.closing()
              await printer.holdCloseOpen
            },
            async execute(action, _args, { beforeSend }) {
              if (!beforeSend()) return { acknowledged: false }
              sent.push(action)
              current = action
              // The save is sent and the reply is lost.
              if (action === 'config_write') throw new Error('socket lost')
              return { acknowledged: true }
            },
            async pauseOnce() {
              return { acknowledged: false }
            },
            async waitForPaused() {
              if (current === 'firmware_restart')
                throw new Error('Klippy disconnected')
              if (current === 'pause') printer.state = 'paused'
              await new Promise((resolve) => setTimeout(resolve, 5))
              return observation()
            },
          }
        },
      },
    })
    t.after(d.close)
    return {
      d,
      async wire(action: ExtendedControlAction) {
        return authority.sign(
          {
            action,
            args: argsOf(action),
            purpose: action === 'pause' ? 'printer-pause' : 'printer-control',
          },
          Math.floor(d.now()),
        )
      },
      async send(action: ExtendedControlAction) {
        const result = await d.dispatch(await this.wire(action))
        return `${result.kind}:${result.reason}`
      },
    }
  }
  const audit = () =>
    readFileSync(join(directory, HOLD_AUDIT_FILE), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
  return { open, sent, printer, directory, audit, authority }
}

export async function held(t: TestContext, commands: ExtendedControlAction[]) {
  const f = await dispatcherFixture(t)
  const c = await f.open(1000)
  for (const action of commands)
    assert.match(await c.send(action), /^outcome-unknown:/, action)
  // The printer comes back and a print is running.
  f.printer.state = 'printing'
  return { f, c }
}
