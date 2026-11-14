import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  BAMBU_AUTHORIZATION_REQUIRED,
  BAMBU_VERIFY_FAILED_ERR_CODE,
  BambuAuthorizationRequired,
  bambuAuthorizationRequired,
  classifyBambuReply,
  mergeBambuReply,
  sentBambuRequest,
} from '../../packages/connector/src/bambu/control-authorization.ts'
import { buildBambuCommand } from '../../packages/connector/src/bambu/commands.ts'
import { ControlResultCode } from '../../packages/farm-protocol/src/control-actions.ts'
import {
  decodePauseChannelFrame,
  encodePauseChannelFrame,
} from '../../packages/farm-protocol/src/pause-channel.ts'
import {
  actionOutcomeText,
  controlStatusText,
  resultCodeHint,
} from '../../apps/farm/app/utils/farm-control.ts'

const sent = { command: 'pause', sequenceId: '7' }

test('the sent request identity comes from the built command', () => {
  assert.deepEqual(
    sentBambuRequest(buildBambuCommand('pause', { sequence_id: '7' })),
    sent,
  )
  assert.deepEqual(
    sentBambuRequest(buildBambuCommand('cancel', { sequence_id: '9' })),
    { command: 'stop', sequenceId: '9' },
  )
  assert.deepEqual(
    sentBambuRequest(
      buildBambuCommand('set_light', { on: true, sequence_id: '3' }),
    ),
    { command: 'ledctrl', sequenceId: '3' },
  )
  for (const bad of [null, 'x', [], {}, { print: { command: 'pause' } }])
    assert.equal(sentBambuRequest(bad), null)
})

test('a verify failure on the report topic is authorization control', () => {
  assert.equal(
    classifyBambuReply(
      {
        print: {
          command: 'pause',
          sequence_id: '7',
          result: 'failed',
          reason: 'mqtt message verify failed',
          err_code: BAMBU_VERIFY_FAILED_ERR_CODE,
        },
      },
      sent,
    ),
    'authorization-required',
  )
  // Either signal alone is enough: the reason text or the error code.
  assert.equal(
    classifyBambuReply(
      {
        print: {
          command: 'pause',
          sequence_id: '7',
          result: 'FAIL',
          reason: 'Authorization required',
        },
      },
      sent,
    ),
    'authorization-required',
  )
  assert.equal(
    classifyBambuReply(
      {
        print: {
          command: 'pause',
          sequence_id: '7',
          err_code: BAMBU_VERIFY_FAILED_ERR_CODE,
        },
      },
      sent,
    ),
    'authorization-required',
  )
  assert.equal(
    classifyBambuReply(
      {
        system: {
          command: 'ledctrl',
          sequence_id: '3',
          result: 'failed',
          reason: 'mqtt message verify failed',
        },
      },
      { command: 'ledctrl', sequenceId: '3' },
    ),
    'authorization-required',
  )
})

test('other replies never claim authorization control', () => {
  const echo = { command: 'pause', sequence_id: '7' }
  assert.equal(
    classifyBambuReply({ print: { ...echo, result: 'success' } }, sent),
    'acknowledged',
  )
  assert.equal(classifyBambuReply({ print: echo }, sent), 'acknowledged')
  assert.equal(
    classifyBambuReply(
      { print: { ...echo, result: 'failed', reason: 'printer is busy' } },
      sent,
    ),
    'failed',
  )
  // Unrelated: status pushes, another command, another sequence, junk.
  for (const report of [
    { print: { command: 'push_status', gcode_state: 'RUNNING' } },
    {
      print: {
        command: 'resume',
        sequence_id: '7',
        result: 'failed',
        reason: 'mqtt message verify failed',
      },
    },
    {
      print: {
        command: 'pause',
        sequence_id: '8',
        result: 'failed',
        reason: 'mqtt message verify failed',
      },
    },
    { print: { ...echo, sequence_id: 7, result: 'failed' } },
    null,
    'text',
    [],
    { print: null },
  ])
    assert.equal(classifyBambuReply(report, sent), 'none')
})

test('the strongest reply of an attempt is kept', () => {
  assert.equal(mergeBambuReply('none', 'acknowledged'), 'acknowledged')
  assert.equal(mergeBambuReply('acknowledged', 'none'), 'acknowledged')
  assert.equal(
    mergeBambuReply('acknowledged', 'authorization-required'),
    'authorization-required',
  )
  assert.equal(
    mergeBambuReply('authorization-required', 'acknowledged'),
    'authorization-required',
  )
  assert.equal(mergeBambuReply('failed', 'acknowledged'), 'failed')
})

test('the hint needs a refusal, or an ack with no state change at timeout', () => {
  const base = { lifecycle: true, timedOut: true, targetReached: false }
  assert.equal(
    bambuAuthorizationRequired({
      reply: 'authorization-required',
      lifecycle: false,
      timedOut: false,
      targetReached: false,
    }),
    true,
  )
  assert.equal(
    bambuAuthorizationRequired({ ...base, reply: 'acknowledged' }),
    true,
  )
  // No ack: a plain timeout stays a plain timeout.
  assert.equal(bambuAuthorizationRequired({ ...base, reply: 'none' }), false)
  assert.equal(bambuAuthorizationRequired({ ...base, reply: 'failed' }), false)
  assert.equal(
    bambuAuthorizationRequired({
      ...base,
      reply: 'acknowledged',
      timedOut: false,
    }),
    false,
  )
  assert.equal(
    bambuAuthorizationRequired({
      ...base,
      reply: 'acknowledged',
      targetReached: true,
    }),
    false,
  )
  // An extended action has no print-state target to miss.
  assert.equal(
    bambuAuthorizationRequired({
      ...base,
      reply: 'acknowledged',
      lifecycle: false,
    }),
    false,
  )
})

test('the driver error carries only the wire result code', () => {
  const error = new BambuAuthorizationRequired()
  assert.equal(error.resultCode, 'bambu-authorization-required')
  assert.equal(BAMBU_AUTHORIZATION_REQUIRED, 'bambu-authorization-required')
  assert.equal(ControlResultCode.safeParse(error.resultCode).success, true)
  assert.equal(ControlResultCode.safeParse('anything-else').success, false)
  assert.doesNotMatch(error.message, /verify|access|password|serial/i)
})

test('the result frame carries the optional code and stays canonical', () => {
  const frame = {
    v: 1 as const,
    t: 'control.result' as const,
    transport_id: randomUUID(),
    seq: 0,
    command_id: randomUUID(),
    outcome: 'outcome-unknown' as const,
  }
  const plain = encodePauseChannelFrame(frame)
  assert.equal(plain.includes('code'), false)
  assert.deepEqual(decodePauseChannelFrame(plain), frame)
  const coded = { ...frame, code: 'bambu-authorization-required' as const }
  assert.deepEqual(
    decodePauseChannelFrame(encodePauseChannelFrame(coded)),
    coded,
  )
  assert.throws(() => encodePauseChannelFrame({ ...frame, code: 'other' }))
  assert.throws(() =>
    encodePauseChannelFrame({ ...frame, t: 'control.proofs-ready', code: 'x' }),
  )
})

test('the operator sees a pt-BR hint to enable LAN-only/Developer mode', () => {
  const hint = resultCodeHint('bambu-authorization-required')
  assert.ok(hint)
  assert.match(hint, /Somente LAN/)
  assert.match(hint, /Modo Desenvolvedor/)
  assert.match(hint, /controle de autorização do firmware/)
  assert.equal(resultCodeHint(undefined), undefined)
  for (const action of ['pause', 'resume', 'cancel'] as const) {
    const generic = actionOutcomeText(action, 'outcome-unknown')
    const hinted = actionOutcomeText(
      action,
      'outcome-unknown',
      'bambu-authorization-required',
    )
    assert.equal(hinted, `${generic} ${hint}`)
    assert.equal(
      controlStatusText(
        action,
        {
          kind: 'settled',
          outcome: 'outcome-unknown',
          code: 'bambu-authorization-required',
        },
        0,
      ),
      hinted,
    )
    assert.equal(
      controlStatusText(
        action,
        { kind: 'settled', outcome: 'outcome-unknown' },
        0,
      ),
      generic,
    )
    // A confirmed command never shows the hint.
    assert.equal(
      actionOutcomeText(action, 'applied', 'bambu-authorization-required'),
      actionOutcomeText(action, 'applied'),
    )
  }
})
