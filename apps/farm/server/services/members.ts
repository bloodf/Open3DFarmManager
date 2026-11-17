import { checkMutationOrigin } from '../utils/auth/boundary.ts'

export type MemberRole = 'owner' | 'admin' | 'operator' | 'viewer'
/** Ownership is never granted here; transfer is a separate, unbuilt flow. */
export type AssignableRole = Exclude<MemberRole, 'owner'>
export type InviteStatus = 'pending' | 'consumed' | 'revoked' | 'expired'
export interface FarmMember {
  accountId: string
  username: string | null
  role: MemberRole
}
/** Never carries the token or its digest. */
export interface FarmInvite {
  id: string
  role: AssignableRole
  createdAt: string
  expiresAt: string
  status: InviteStatus
}
export type MemberChange = 'ok' | 'not-found' | 'last-owner'
export type InviteRevocation = 'ok' | 'not-found' | 'consumed'

/**
 * Every method authorizes the actor as an active owner of the farm in its own
 * transaction. Non-owners and unknown farms are indistinguishable: null or not-found.
 */
export interface MembersStore {
  listMembers(actorId: string, farmId: string): Promise<FarmMember[] | null>
  changeRole(
    actorId: string,
    farmId: string,
    accountId: string,
    role: AssignableRole,
  ): Promise<MemberChange>
  /** Tombstones the membership and revokes every session of that account. */
  removeMember(
    actorId: string,
    farmId: string,
    accountId: string,
    now: number,
  ): Promise<MemberChange>
  listInvites(actorId: string, farmId: string): Promise<FarmInvite[] | null>
  revokeInvite(
    actorId: string,
    farmId: string,
    inviteId: string,
  ): Promise<InviteRevocation>
}
export interface MembersDeps {
  origin: string
  store: MembersStore | undefined
  /** Rejects with the caller's own 401/503 error when there is no valid session. */
  authenticate(): Promise<{ accountId: string }>
  /** Rejects when the per-account budget is spent. */
  limit(key: string): Promise<void>
  now?: () => number
}
export class MembersError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const account = /^[A-Za-z0-9_-]{1,128}$/
const assignable: readonly string[] = ['admin', 'operator', 'viewer']
const notFound = () => new MembersError(404, 'Recurso não encontrado.')
const forbiddenOrigin = () =>
  new MembersError(403, 'Origem da solicitação não permitida.')
const lastOwner = () =>
  new MembersError(
    409,
    'A farm precisa de pelo menos um proprietário. Não é possível remover ou rebaixar o último.',
  )

function store(deps: MembersDeps): MembersStore {
  if (!deps.store) throw notFound()
  return deps.store
}
/** Reads may omit Origin (same-origin navigation), but a foreign Origin is refused. */
async function reader(deps: MembersDeps, request: Request, farmId: string) {
  const active = store(deps)
  const origin = request.headers.get('origin')
  if (origin !== null && !checkMutationOrigin(origin, deps.origin).ok)
    throw forbiddenOrigin()
  const { accountId } = await deps.authenticate()
  if (!uuid.test(farmId)) throw notFound()
  return { active, accountId }
}
async function writer(deps: MembersDeps, request: Request, farmId: string) {
  const active = store(deps)
  if (!checkMutationOrigin(request.headers.get('origin'), deps.origin).ok)
    throw forbiddenOrigin()
  const { accountId } = await deps.authenticate()
  await deps.limit('members:' + accountId)
  if (!uuid.test(farmId)) throw notFound()
  return { active, accountId }
}
function changed(result: MemberChange): void {
  if (result === 'not-found') throw notFound()
  if (result === 'last-owner') throw lastOwner()
}
async function readRole(request: Request): Promise<AssignableRole> {
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim() !==
      'application/json' ||
    request.headers.has('content-encoding')
  )
    throw new MembersError(415, 'Envie os dados em JSON.')
  const invalid = () => new MembersError(400, 'Função inválida.')
  let data: unknown
  try {
    const text = await request.text()
    if (text.length > 256) throw new Error()
    data = JSON.parse(text)
  } catch {
    throw invalid()
  }
  if (
    typeof data !== 'object' ||
    data === null ||
    Object.keys(data).length !== 1 ||
    !('role' in data) ||
    typeof data.role !== 'string' ||
    !assignable.includes(data.role)
  )
    throw invalid()
  return data.role as AssignableRole
}

export async function listMembers(
  deps: MembersDeps,
  request: Request,
  farmId: string,
): Promise<{ members: FarmMember[] }> {
  const { active, accountId } = await reader(deps, request, farmId)
  const members = await active.listMembers(accountId, farmId)
  if (!members) throw notFound()
  return { members }
}
export async function changeMemberRole(
  deps: MembersDeps,
  request: Request,
  farmId: string,
  memberId: string,
): Promise<{ accountId: string; role: AssignableRole }> {
  const { active, accountId } = await writer(deps, request, farmId)
  const role = await readRole(request)
  if (!account.test(memberId)) throw notFound()
  changed(await active.changeRole(accountId, farmId, memberId, role))
  return { accountId: memberId, role }
}
export async function removeMember(
  deps: MembersDeps,
  request: Request,
  farmId: string,
  memberId: string,
): Promise<{ message: string }> {
  const { active, accountId } = await writer(deps, request, farmId)
  if (!account.test(memberId)) throw notFound()
  changed(
    await active.removeMember(
      accountId,
      farmId,
      memberId,
      (deps.now ?? Date.now)(),
    ),
  )
  return { message: 'Membro removido. As sessões dele foram encerradas.' }
}
export async function listInvites(
  deps: MembersDeps,
  request: Request,
  farmId: string,
): Promise<{ invites: FarmInvite[] }> {
  const { active, accountId } = await reader(deps, request, farmId)
  const invites = await active.listInvites(accountId, farmId)
  if (!invites) throw notFound()
  return { invites }
}
export async function revokeInvite(
  deps: MembersDeps,
  request: Request,
  farmId: string,
  inviteId: string,
): Promise<{ message: string }> {
  const { active, accountId } = await writer(deps, request, farmId)
  if (!uuid.test(inviteId)) throw notFound()
  const result = await active.revokeInvite(accountId, farmId, inviteId)
  if (result === 'not-found') throw notFound()
  if (result === 'consumed')
    throw new MembersError(409, 'Este convite já foi usado.')
  return { message: 'Convite revogado.' }
}
