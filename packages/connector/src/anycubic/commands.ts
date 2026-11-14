import { randomUUID } from 'node:crypto'

// Wire format: https://github.com/rvanderp3/kobra-connect/blob/main/docs/mqtt-commands.md
export type AnycubicAction =
  'pause' | 'resume' | 'stop' | 'nozzle' | 'bed' | 'fan' | 'light'
const actions: AnycubicAction[] = [
  'pause',
  'resume',
  'stop',
  'nozzle',
  'bed',
  'fan',
  'light',
]

export function supportedAnycubicActions(model: string): AnycubicAction[] {
  return model === '20024' ? [...actions] : []
}

export function buildAnycubicCommand(
  action: AnycubicAction,
  args: { value?: number; taskId?: string } = {},
) {
  if (!actions.includes(action)) throw new Error('Unsupported Anycubic action')
  const common = { timestamp: Date.now(), msgid: randomUUID() }
  if (action === 'pause' || action === 'resume' || action === 'stop')
    return {
      type: 'print',
      action,
      ...common,
      data: { taskid: args.taskId ?? '-1' },
    }
  const value = args.value
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > (action === 'nozzle' ? 300 : action === 'bed' ? 120 : 100)
  )
    throw new Error('Invalid Anycubic command value')
  if (action === 'light') {
    if (value !== 0 && value !== 1)
      throw new Error('Invalid Anycubic light value')
    return {
      type: 'light',
      action: 'control',
      ...common,
      data: { type: 3, status: value, brightness: value * 100 },
    }
  }
  const key =
    action === 'nozzle'
      ? 'target_nozzle_temp'
      : action === 'bed'
        ? 'target_hotbed_temp'
        : 'fan_speed_pct'
  return {
    type: 'print',
    action: 'update',
    ...common,
    data: { taskid: args.taskId ?? '-1', settings: { [key]: value } },
  }
}
