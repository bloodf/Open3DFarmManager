// SPDX-License-Identifier: AGPL-3.0-or-later
import { createError, type RequestEvent } from 'nuxt/server'
import { z } from 'zod'
import { authRuntime, type AuthRuntime } from '../utils/auth/runtime.ts'
import { spoolLibraryPool } from '../utils/spool-library/runtime.ts'
import {
  PostgresSpoolMoves,
  SpoolMoveError,
  type SpoolMoves,
} from '../storage/postgres-spool-moves.ts'
import {
  authResponse,
  mutation,
  sealedSessionRecordId,
} from './authenticated-session.ts'
import { body } from './spool-usage.ts'

export interface SpoolMovesDeps {
  auth: AuthRuntime
  moves: SpoolMoves
}

const id = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())
const location = z.string().max(256).nullable()
const moveSchema = z.discriminatedUnion('to', [
  z.strictObject({ to: z.literal('location'), location }),
  z.strictObject({
    to: z.literal('slot'),
    printerId: id,
    slotKind: z.enum(['printer', 'ams', 'toolhead']),
    slotIndex: z.number().int().min(0).max(1024),
  }),
  z.strictObject({
    to: z.literal('farm'),
    farmId: id,
    location: location.optional(),
  }),
])

const MESSAGES: Record<number, string> = {
  400: 'Solicitação inválida.',
  401: 'Entre novamente para continuar.',
  403: 'Seu papel na farm não permite mover bobinas.',
  404: 'Bobina, impressora ou farm indisponível para esta conta.',
  409: 'A bobina está arquivada ou já foi movida. Atualize a lista e confira.',
  503: 'Não foi possível mover a bobina agora. Confira antes de tentar de novo.',
}
const failure = (status: number) =>
  createError({ status, message: MESSAGES[status] ?? MESSAGES[503]! })

/**
 * Authenticated spool move (`move`) or move journal (`history`) for the farm in
 * the path. Storage checks membership of every farm the move touches.
 */
export async function spoolMoves(
  event: Pick<RequestEvent, 'req' | 'res'>,
  farmId: string | undefined,
  spoolId: string | undefined,
  op: 'move' | 'history',
  deps?: SpoolMovesDeps,
) {
  const auth = deps?.auth ?? authRuntime()
  authResponse(event)
  if (op === 'move') mutation(event, auth)
  const sessionRecordId = await sealedSessionRecordId(event, auth)
  if (!farmId || !spoolId || !/^[1-9]\d{0,15}$/.test(spoolId))
    throw failure(400)
  let target: z.infer<typeof moveSchema> | undefined
  if (op === 'move') {
    const parsed = moveSchema.safeParse(await body(event.req))
    if (!parsed.success) throw failure(400)
    target = parsed.data
  }
  try {
    const moves =
      deps?.moves ?? new PostgresSpoolMoves(await spoolLibraryPool())
    const authority = {
      farmId,
      sessionRecordId,
      policy: { idleTimeoutMs: auth.idleTimeoutMs },
    }
    return target
      ? await moves.move(authority, Number(spoolId), target)
      : await moves.history(authority, Number(spoolId))
  } catch (error) {
    if (error instanceof SpoolMoveError) throw failure(error.status)
    if (error && typeof error === 'object' && 'status' in error) throw error
    throw failure(503)
  }
}
