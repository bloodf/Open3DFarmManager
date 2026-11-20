import { formatDateTime } from './ui-format.ts'
/** Display and mutation helpers for the members management page (issue #218). */

export type MemberRole = 'owner' | 'admin' | 'operator' | 'viewer'
export type AssignableRole = Exclude<MemberRole, 'owner'>
export type InviteStatus = 'pending' | 'consumed' | 'revoked' | 'expired'

export interface FarmMember {
  accountId: string
  username: string | null
  role: MemberRole
}

export interface FarmInvite {
  id: string
  role: AssignableRole
  createdAt: string
  expiresAt: string
  status: InviteStatus
}

export const roleLabel = {
  owner: 'Proprietário',
  admin: 'Administrador',
  operator: 'Operador',
  viewer: 'Visualizador',
} as const satisfies Record<MemberRole, string>

export const inviteStatusLabel = {
  pending: 'Pendente',
  consumed: 'Usado',
  revoked: 'Revogado',
  expired: 'Expirado',
} as const satisfies Record<InviteStatus, string>

export const assignableRoles: readonly {
  value: AssignableRole
  label: string
}[] = [
  { value: 'viewer', label: roleLabel.viewer },
  { value: 'operator', label: roleLabel.operator },
  { value: 'admin', label: roleLabel.admin },
]

export type ConfirmKind = 'role' | 'remove' | 'revoke'

export type ConfirmTarget =
  | { kind: 'role'; member: FarmMember; role: AssignableRole }
  | { kind: 'remove'; member: FarmMember }
  | { kind: 'revoke'; invite: FarmInvite }

/** Pending invites only; consumed, revoked and expired stay out of the action list. */
export function pendingInvites(invites: readonly FarmInvite[]): FarmInvite[] {
  return invites.filter((invite) => invite.status === 'pending')
}

export function memberDisplayName(member: FarmMember): string {
  const name = member.username?.trim()
  return name && name.length > 0 ? name : member.accountId
}

export function formatInviteExpiry(expiresAt: string): string {
  const at = Date.parse(expiresAt)
  if (!Number.isFinite(at)) return 'data desconhecida'
  return formatDateTime(at, 'short') ?? 'data desconhecida'
}

export function membersLoadError(status: number | undefined): string {
  if (status === 401)
    return 'Entre na sua conta para gerenciar membros e convites.'
  if (status === 403)
    return 'Somente proprietários da farm podem gerenciar membros e convites.'
  if (status === 404) return 'Farm não encontrada ou sem permissão.'
  return 'Não foi possível carregar membros e convites. Tente novamente.'
}

export function membersMutationError(status: number | undefined): string {
  if (status === 403)
    return 'Somente proprietários da farm podem alterar membros e convites.'
  if (status === 404) return 'Recurso não encontrado.'
  if (status === 409)
    return 'A farm precisa de pelo menos um proprietário. Não é possível remover ou rebaixar o último.'
  if (status === 429)
    return 'Muitas tentativas. Aguarde um pouco antes de tentar novamente.'
  return 'Não foi possível concluir a ação agora. Tente novamente mais tarde.'
}

export function confirmTitle(target: ConfirmTarget): string {
  switch (target.kind) {
    case 'role':
      return `Alterar papel de ${memberDisplayName(target.member)}`
    case 'remove':
      return `Remover ${memberDisplayName(target.member)}`
    case 'revoke':
      return 'Revogar convite pendente'
    default: {
      const _exhaustive: never = target
      return _exhaustive
    }
  }
}

export function confirmDescription(target: ConfirmTarget): string {
  switch (target.kind) {
    case 'role':
      return `O papel de ${memberDisplayName(target.member)} passará de ${roleLabel[target.member.role]} para ${roleLabel[target.role]}.`
    case 'remove':
      return `${memberDisplayName(target.member)} perderá o acesso a esta farm e todas as sessões dessa conta serão encerradas.`
    case 'revoke':
      return `O convite de ${roleLabel[target.invite.role]} deixará de funcionar. Quem ainda não usou o link não poderá criar a conta com ele.`
    default: {
      const _exhaustive: never = target
      return _exhaustive
    }
  }
}

export function confirmCheckboxLabel(kind: ConfirmKind): string {
  switch (kind) {
    case 'role':
      return 'Confirmei a alteração de papel.'
    case 'remove':
      return 'Confirmei a remoção deste membro.'
    case 'revoke':
      return 'Confirmei a revogação deste convite.'
    default: {
      const _exhaustive: never = kind
      return _exhaustive
    }
  }
}

export function confirmButtonLabel(kind: ConfirmKind): string {
  switch (kind) {
    case 'role':
      return 'Confirmar alteração de papel'
    case 'remove':
      return 'Confirmar remoção'
    case 'revoke':
      return 'Confirmar revogação'
    default: {
      const _exhaustive: never = kind
      return _exhaustive
    }
  }
}

export function pendingStatus(kind: ConfirmKind | 'load'): string {
  switch (kind) {
    case 'load':
      return 'Carregando membros e convites…'
    case 'role':
      return 'Alterando papel…'
    case 'remove':
      return 'Removendo membro…'
    case 'revoke':
      return 'Revogando convite…'
    default: {
      const _exhaustive: never = kind
      return _exhaustive
    }
  }
}

export function successMessage(kind: ConfirmKind): string {
  switch (kind) {
    case 'role':
      return 'Papel atualizado.'
    case 'remove':
      return 'Membro removido. As sessões dele foram encerradas.'
    case 'revoke':
      return 'Convite revogado.'
    default: {
      const _exhaustive: never = kind
      return _exhaustive
    }
  }
}

/** Role select is for assignable targets; owners appear with their current role for demotion. */
export function roleSelectValue(member: FarmMember): AssignableRole | '' {
  if (member.role === 'owner') return ''
  return member.role
}
