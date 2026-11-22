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
