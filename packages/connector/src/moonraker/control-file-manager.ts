import { z } from 'zod'
import { FileOperation } from '../../../farm-protocol/src/control-actions.ts'

export class FileOperationRefused extends Error {
  readonly refusal: 'state' | 'invalid-command' | 'unsupported-action'

  constructor(refusal: FileOperationRefused['refusal']) {
    super(`File operation refused: ${refusal}`)
    this.refusal = refusal
  }
}

const FileState = z.object({
  status: z.object({
    webhooks: z.object({ state: z.literal('ready') }),
    print_stats: z.object({
      state: z.enum(['standby', 'complete', 'cancelled']),
    }),
  }),
})

export async function requireStoppedPrinter(
  read: (method: string, params: object) => Promise<unknown>,
) {
  // Require a stopped printer even when the source is a directory.
  const state = await read('printer.objects.query', {
    objects: { webhooks: ['state'], print_stats: ['state'] },
  }).catch(() => undefined)
  if (!FileState.safeParse(state).success)
    throw new FileOperationRefused('state')
}

export async function prepareFileOperation(
  args: unknown,
  read: (method: string, params: object) => Promise<unknown>,
) {
  const parsed = FileOperation.safeParse(args)
  if (!parsed.success) throw new FileOperationRefused('invalid-command')
  const { op, path } = parsed.data
  await requireStoppedPrinter(read)
  const source = `gcodes/${path}`
  switch (op) {
    case 'delete':
      return { method: 'server.files.delete_file', params: { path: source } }
    case 'mkdir':
      return { method: 'server.files.post_directory', params: { path: source } }
    case 'move':
      return {
        method: 'server.files.move',
        params: { source, dest: `gcodes/${parsed.data.to}` },
      }
  }
}

export function fileOperationAcknowledged(result: unknown, args: unknown) {
  const operation = FileOperation.safeParse(args)
  const reply = z
    .object({
      action: z.string(),
      item: z.object({ root: z.literal('gcodes'), path: z.string() }),
    })
    .safeParse(result)
  if (!operation.success || !reply.success) return false
  const { data } = operation
  return (
    reply.data.action ===
      { delete: 'delete_file', move: 'move_file', mkdir: 'create_dir' }[
        data.op
      ] && reply.data.item.path === (data.op === 'move' ? data.to : data.path)
  )
}
