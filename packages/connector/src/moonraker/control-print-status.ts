import { ExcludeObjectArguments } from '../../../farm-protocol/src/control-actions.ts'
import { fields, list } from './detail-normalize.ts'

export class ExcludeObjectRefusal extends Error {
  constructor(
    message: string,
    readonly refusal:
      'state' | 'unsupported-action' | 'invalid-command' = 'state',
  ) {
    super(message)
  }
}

export function excludeObjectWire(args: unknown, result: unknown) {
  const parsed = ExcludeObjectArguments.safeParse(args)
  if (!parsed.success)
    throw new ExcludeObjectRefusal(
      'Invalid print object name',
      'invalid-command',
    )
  const { name } = parsed.data
  const status = fields(fields(result).status)
  const state = fields(status.print_stats).state
  if (
    fields(status.webhooks).state !== 'ready' ||
    (state !== 'printing' && state !== 'paused')
  )
    throw new ExcludeObjectRefusal('Object exclusion requires an active print')
  const objects = fields(status.exclude_object)
  if (!list(objects.objects).some((object) => fields(object).name === name))
    throw new ExcludeObjectRefusal('Unknown print object')
  if (
    !Array.isArray(objects.excluded_objects) ||
    objects.excluded_objects.includes(name)
  )
    throw new ExcludeObjectRefusal('Print object unavailable')
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'printer.gcode.script',
    params: { script: `EXCLUDE_OBJECT NAME=${name}` },
  })
}

export const excludeObjectProbe = (id: number) =>
  JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'printer.objects.query',
    params: {
      objects: {
        print_stats: ['state'],
        webhooks: ['state'],
        exclude_object: ['objects', 'excluded_objects'],
      },
    },
  })
