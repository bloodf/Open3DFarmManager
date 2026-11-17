// Members page logic and accessibility markers (issue #218). No services.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  assignableRoles,
  confirmButtonLabel,
  confirmCheckboxLabel,
  confirmDescription,
  confirmTitle,
  formatInviteExpiry,
  memberDisplayName,
  membersLoadError,
  membersMutationError,
  pendingInvites,
  pendingStatus,
  roleLabel,
  roleSelectValue,
  successMessage,
  type FarmInvite,
  type FarmMember,
} from '../../apps/farm/app/utils/members-page.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const pagePath = join(root, 'apps/farm/app/pages/membros.vue')
const listPath = join(root, 'apps/farm/app/components/members/MembersList.vue')
const invitesPath = join(
  root,
  'apps/farm/app/components/members/InvitesList.vue',
)
const dialogPath = join(
  root,
  'apps/farm/app/components/members/MembersConfirmDialog.vue',
)

const member = (
  accountId: string,
  role: FarmMember['role'],
  username: string | null = accountId,
): FarmMember => ({ accountId, username, role })

function invitesFixture(now: number): FarmInvite[] {
  // Every expiry derives from this single clock reading.
  return [
    {
      id: '11111111-1111-4111-8111-111111111111',
      role: 'viewer',
      createdAt: new Date(now - 3_600_000).toISOString(),
      expiresAt: new Date(now + 72 * 3_600_000).toISOString(),
      status: 'pending',
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      role: 'admin',
      createdAt: new Date(now - 3_600_000).toISOString(),
      expiresAt: new Date(now - 60_000).toISOString(),
      status: 'expired',
    },
    {
      id: '33333333-3333-4333-8333-333333333333',
      role: 'operator',
      createdAt: new Date(now - 3_600_000).toISOString(),
      expiresAt: new Date(now + 3_600_000).toISOString(),
      status: 'revoked',
    },
    {
      id: '44444444-4444-4444-8444-444444444444',
      role: 'viewer',
      createdAt: new Date(now - 3_600_000).toISOString(),
      expiresAt: new Date(now + 3_600_000).toISOString(),
      status: 'consumed',
    },
  ]
}

test('pending invites exclude consumed, revoked and expired', () => {
  const now = Date.now()
  const pending = pendingInvites(invitesFixture(now))
  assert.deepEqual(
    pending.map((invite) => invite.id),
    ['11111111-1111-4111-8111-111111111111'],
  )
})

test('role labels, display names and select defaults are pt-BR', () => {
  assert.equal(roleLabel.owner, 'Proprietário')
  assert.equal(roleLabel.viewer, 'Visualizador')
  assert.deepEqual(
    assignableRoles.map((role) => role.value),
    ['viewer', 'operator', 'admin'],
  )
  assert.equal(memberDisplayName(member('a1', 'admin', 'ana')), 'ana')
  assert.equal(memberDisplayName(member('a1', 'admin', '  ')), 'a1')
  assert.equal(memberDisplayName(member('a1', 'admin', null)), 'a1')
  assert.equal(roleSelectValue(member('a1', 'owner')), '')
  assert.equal(roleSelectValue(member('a1', 'operator')), 'operator')
})

test('confirm copy covers role change, removal and invite revocation', () => {
  const admin = member('admin', 'admin', 'Admin')
  const now = Date.now()
  const invite = invitesFixture(now)[0]!
  assert.equal(
    confirmTitle({ kind: 'role', member: admin, role: 'viewer' }),
    'Alterar papel de Admin',
  )
  assert.match(
    confirmDescription({ kind: 'role', member: admin, role: 'viewer' }),
    /Administrador.*Visualizador/,
  )
  assert.match(confirmDescription({ kind: 'remove', member: admin }), /sessões/)
  assert.match(confirmDescription({ kind: 'revoke', invite }), /Visualizador/)
  assert.equal(confirmCheckboxLabel('role'), 'Confirmei a alteração de papel.')
  assert.equal(confirmButtonLabel('remove'), 'Confirmar remoção')
  assert.equal(confirmButtonLabel('revoke'), 'Confirmar revogação')
  assert.equal(successMessage('role'), 'Papel atualizado.')
  assert.equal(pendingStatus('load'), 'Carregando membros e convites…')
})

test('load and mutation errors stay generic and pt-BR', () => {
  assert.match(membersLoadError(401), /Entre na sua conta/)
  assert.match(membersLoadError(403), /Somente proprietários/)
  assert.match(membersMutationError(409), /pelo menos um proprietário/)
  assert.match(membersMutationError(429), /Muitas tentativas/)
  assert.match(membersMutationError(503), /Tente novamente/)
})

test('invite expiry formatting uses a fixed locale', () => {
  const now = Date.now()
  const expiresAt = new Date(now + 3_600_000).toISOString()
  assert.match(formatInviteExpiry(expiresAt), /\d/)
  assert.equal(formatInviteExpiry('not-a-date'), 'data desconhecida')
})

test('page announces pending and error states and requires confirmation', async () => {
  const page = await readFile(pagePath, 'utf8')
  assert.match(page, /role="alert"/)
  assert.match(page, /role="status"/)
  assert.match(page, /aria-live="polite"/)
  assert.match(page, /tabindex="-1"/)
  assert.match(page, /errorSummary\.value\?\.focus\(\)/)
  assert.match(page, /MembersConfirmDialog/)
  assert.match(page, /pendingStatus\('load'\)/)
  assert.match(page, /\/members\/\$\{.*\}\/role/)
  assert.match(page, /\/members\/\$\{.*\}\/remove/)
  assert.match(page, /\/invites\/\$\{.*\}\/revoke/)
  assert.match(page, /:aria-busy="pending"/)
})

test('lists expose accessible labels and action controls', async () => {
  const list = await readFile(listPath, 'utf8')
  const invites = await readFile(invitesPath, 'utf8')
  const dialog = await readFile(dialogPath, 'utf8')
  assert.match(list, /:for="selectId\(member\)"/)
  assert.match(list, /:aria-label="`Novo papel para \$\{/)
  assert.match(list, /:aria-label="`Remover \$\{/)
  assert.match(list, /Alterar papel/)
  assert.match(list, /^\s*Remover\s*$/m)
  assert.match(invites, /:aria-label="`Revogar convite de \$\{/)
  assert.match(invites, /Revogar convite/)
  assert.match(dialog, /showModal\(\)/)
  assert.match(dialog, /aria-labelledby="members-confirm-title"/)
  assert.match(dialog, /type="checkbox"/)
  assert.match(dialog, /:disabled="pending \|\| !confirmed"/)
  assert.match(dialog, /focus-visible/)
  assert.match(list, /focus-visible/)
})

test('browser-facing remove and role-change paths go through confirmation', async () => {
  const page = await readFile(pagePath, 'utf8')
  assert.match(page, /openConfirm\(\{ kind: 'role'/)
  assert.match(page, /openConfirm\(\{ kind: 'remove'/)
  assert.match(page, /openConfirm\(\{ kind: 'revoke'/)
  assert.match(page, /if \(!target \|\| !confirmChecked\.value/)
  assert.match(
    page,
    /\/api\/farms\/\$\{farmId\.value\}\/members\/\$\{target\.member\.accountId\}\/role/,
  )
  assert.match(
    page,
    /\/api\/farms\/\$\{farmId\.value\}\/members\/\$\{target\.member\.accountId\}\/remove/,
  )
})
