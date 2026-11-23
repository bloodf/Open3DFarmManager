import { expect, test } from 'vitest'
import { decodeAnycubicReport } from '../../packages/connector/src/anycubic/report.ts'

const decode = (data: unknown) =>
  decodeAnycubicReport(Buffer.from(JSON.stringify({ data })))

test('converts LAN project and progress estimates from minutes to seconds', () => {
  expect(
    decode({
      state: 'busy',
      project: { state: 'printing', pause: 1, progress: 25, remain_time: 92 },
    }),
  ).toEqual({
    kind: 'observation',
    state: 'paused',
    progress: 25,
    estimatedRemainingSeconds: 5520,
  })
  expect(decode({ progress: 99, remain_time: 0 })).toEqual({
    kind: 'observation',
    progress: 99,
    estimatedRemainingSeconds: 0,
  })
})

test.each([undefined, null, -1, 1.5, '12', Number.MAX_SAFE_INTEGER])(
  'keeps the valid progress when remaining time is %s',
  (remain_time) => {
    expect(decode({ progress: 25, remain_time })).toEqual({
      kind: 'observation',
      progress: 25,
    })
  },
)

test('prefers a valid direct estimate and uses the project estimate when the direct field is invalid', () => {
  for (const [remain_time, seconds] of [
    [0, 0],
    [-1, 540],
    ['12', 540],
  ]) {
    expect(
      decode({
        state: 'busy',
        remain_time,
        project: { state: 'printing', remain_time: 9 },
      }),
    ).toMatchObject({ state: 'printing', estimatedRemainingSeconds: seconds })
  }
})

test.each(['checking', 'auto_leveling', 'stoped', 'stopped', 'future_phase'])(
  'drops the estimate in phase %s from both project and print reports',
  (state) => {
    for (const data of [
      { state: 'busy', project: { state, remain_time: 0 } },
      { state, remain_time: 0 },
      { project: { state, remain_time: 0 } },
    ]) {
      expect(decode(data)).toEqual({
        kind: 'observation',
        estimateBlocked: true,
      })
    }
  },
)

test('keeps estimates in partial reports and recognizes an explicit project error', () => {
  expect(decode({ state: 'busy', project: { remain_time: 9 } })).toEqual({
    kind: 'observation',
    estimatedRemainingSeconds: 540,
  })
  expect(
    decode({ state: 'busy', project: { state: 'error', remain_time: 0 } }),
  ).toEqual({ kind: 'observation', state: 'error' })
})
