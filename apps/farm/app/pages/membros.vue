<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import Button from '../components/ui/Button.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import ErrorState from '../components/ui/ErrorState.vue'
import Skeleton from '../components/ui/Skeleton.vue'
import StaleNotice from '../components/ui/StaleNotice.vue'
import InvitesList from '../components/members/InvitesList.vue'
import MembersConfirmDialog from '../components/members/MembersConfirmDialog.vue'
import MembersList from '../components/members/MembersList.vue'
import {
  membersLoadError,
  membersMutationError,
  pendingInvites,
  pendingStatus,
  successMessage,
  type AssignableRole,
  type ConfirmTarget,
  type FarmInvite,
  type FarmMember,
} from '../utils/members-page.ts'

type Farm = { farmId: string }

const farms = ref<Farm[]>([])
const farmId = ref('')
const members = ref<FarmMember[]>([])
const invites = ref<FarmInvite[]>([])
const loading = ref(true)
const pending = ref(false)
const errorMessage = ref('')
const loadFailed = ref(false)
const stale = ref(false)
const statusMessage = ref('')
const errorSummary = ref<HTMLElement | null>(null)
const confirmTarget = ref<ConfirmTarget | null>(null)
const confirmChecked = ref(false)
const confirmStatus = ref('')
const farmSelect = ref<HTMLSelectElement | null>(null)

const visibleInvites = computed(() => pendingInvites(invites.value))
// A failed action keeps the confirmation open, so its message belongs there;
// everything else is announced by the page-level alert.
const dialogError = computed(() =>
  confirmTarget.value && !loadFailed.value ? errorMessage.value : '',
)
const pageError = computed(() =>
  confirmTarget.value && !loadFailed.value ? '' : errorMessage.value,
)

async function loadDirectory(selected: string) {
  const [memberPage, invitePage] = await Promise.all([
    $fetch<{ members: FarmMember[] }>(`/api/farms/${selected}/members`, {
      retry: 0,
      timeout: 15_000,
    }),
    $fetch<{ invites: FarmInvite[] }>(`/api/farms/${selected}/invites`, {
      retry: 0,
      timeout: 15_000,
    }),
  ])
  members.value = memberPage.members
  invites.value = invitePage.invites
}

async function refresh() {
  if (!farmId.value) {
    members.value = []
    invites.value = []
    return
  }
  loading.value = true
  errorMessage.value = ''
  loadFailed.value = false
  stale.value = false
  statusMessage.value = pendingStatus('load')
  try {
    await loadDirectory(farmId.value)
    statusMessage.value = ''
  } catch (error: unknown) {
    members.value = []
    invites.value = []
    loadFailed.value = true
    const status =
      error && typeof error === 'object' && 'statusCode' in error
        ? error.statusCode
        : undefined
    errorMessage.value = membersLoadError(
      typeof status === 'number' ? status : undefined,
    )
    statusMessage.value = ''
    await nextTick()
    errorSummary.value?.focus()
  } finally {
    loading.value = false
  }
}

async function start() {
  loading.value = true
  errorMessage.value = ''
  loadFailed.value = false
  try {
    const page = await $fetch<{ farms: Farm[] }>('/api/farms', {
      query: { limit: 50 },
      retry: 0,
      timeout: 15_000,
    })
    farms.value = page.farms
    farmId.value = page.farms[0]?.farmId ?? ''
    if (farmId.value) await refresh()
    else loading.value = false
  } catch (error: unknown) {
    loading.value = false
    loadFailed.value = true
    const status =
      error && typeof error === 'object' && 'statusCode' in error
        ? error.statusCode
        : undefined
    errorMessage.value = membersLoadError(
      typeof status === 'number' ? status : 401,
    )
    await nextTick()
    errorSummary.value?.focus()
  }
}
onMounted(async () => {
  await start()
})

watch(farmId, () => {
  if (!loading.value) void refresh()
})

function openConfirm(target: ConfirmTarget) {
  if (pending.value) return
  confirmTarget.value = target
  confirmChecked.value = false
  confirmStatus.value = ''
  errorMessage.value = ''
}

function closeConfirm() {
  if (pending.value) return
  confirmTarget.value = null
  confirmChecked.value = false
  confirmStatus.value = ''
}

async function runConfirmed() {
  const target = confirmTarget.value
  if (!target || !confirmChecked.value || pending.value || !farmId.value) return
  pending.value = true
  errorMessage.value = ''
  statusMessage.value = pendingStatus(target.kind)
  confirmStatus.value = pendingStatus(target.kind)
  try {
    switch (target.kind) {
      case 'role':
        await $fetch(
          `/api/farms/${farmId.value}/members/${target.member.accountId}/role`,
          {
            method: 'POST',
            body: { role: target.role },
            retry: 0,
            timeout: 15_000,
          },
        )
        break
      case 'remove':
        await $fetch(
          `/api/farms/${farmId.value}/members/${target.member.accountId}/remove`,
          {
            method: 'POST',
            body: {},
            retry: 0,
            timeout: 15_000,
          },
        )
        break
      case 'revoke':
        await $fetch(
          `/api/farms/${farmId.value}/invites/${target.invite.id}/revoke`,
          {
            method: 'POST',
            body: {},
            retry: 0,
            timeout: 15_000,
          },
        )
        break
      default: {
        const _exhaustive: never = target
        throw new Error(String(_exhaustive))
      }
    }
    statusMessage.value = successMessage(target.kind)
    confirmTarget.value = null
    confirmChecked.value = false
    confirmStatus.value = ''
    try {
      await loadDirectory(farmId.value)
      stale.value = false
    } catch {
      stale.value = true
    }
    // The row that opened the dialog may be gone: keep keyboard focus on the page.
    await nextTick()
    if (!document.activeElement || document.activeElement === document.body)
      farmSelect.value?.focus()
  } catch (error: unknown) {
    const status =
      error && typeof error === 'object' && 'statusCode' in error
        ? error.statusCode
        : undefined
    errorMessage.value = membersMutationError(
      typeof status === 'number' ? status : undefined,
    )
    statusMessage.value = ''
    confirmStatus.value = ''
    await nextTick()
    errorSummary.value?.focus()
  } finally {
    pending.value = false
  }
}

function onChangeRole(member: FarmMember, role: AssignableRole) {
  openConfirm({ kind: 'role', member, role })
}

function onRemove(member: FarmMember) {
  openConfirm({ kind: 'remove', member })
}

function onRevoke(invite: FarmInvite) {
  openConfirm({ kind: 'revoke', invite })
}
</script>

<template>
  <main id="conteudo" class="members-page">
    <header class="page-header">
      <p class="eyebrow">Open3DFarmManager</p>
      <h1>Membros e convites</h1>
      <p class="intro">
        Gerencie quem participa desta farm e revogue convites pendentes. Cada
        alteração de papel, remoção ou revogação exige confirmação.
      </p>
      <p class="actions">
        <NuxtLink to="/convites">Criar novo convite</NuxtLink>
      </p>
    </header>
    <div v-if="pageError" ref="errorSummary" role="alert" tabindex="-1">
      <ErrorState
        v-if="loadFailed"
        title="Membros indisponíveis"
        :description="pageError"
      >
        <div class="actions">
          <Button @click="farmId ? refresh() : start()">
            Tentar novamente
          </Button>
          <NuxtLink to="/entrar">Entrar na conta</NuxtLink>
        </div>
      </ErrorState>
      <ErrorState v-else title="Ação não concluída" :description="pageError" />
    </div>
    <div class="live" role="status" aria-live="polite" aria-atomic="true">
      <p v-if="!loading && statusMessage" class="notice">{{ statusMessage }}</p>
    </div>
    <div v-if="loading && !farms.length" aria-busy="true" class="loading panel">
      <p role="status">{{ pendingStatus('load') }}</p>
      <Skeleton /><Skeleton /><Skeleton />
    </div>
    <EmptyState
      v-else-if="!loading && !loadFailed && !farms.length"
      title="Nenhuma farm disponível"
      description="Sua conta ainda não tem uma farm para gerenciar. Crie ou peça acesso a uma farm e volte a esta página."
    >
      <NuxtLink to="/farm">Abrir a página da farm</NuxtLink>
    </EmptyState>
    <div v-if="farms.length" class="content" :aria-busy="pending">
      <StaleNotice
        v-if="stale"
        title="Lista desatualizada"
        description="A alteração foi salva, mas não foi possível atualizar a lista. Os dados abaixo podem estar antigos."
      >
        <Button :disabled="pending" @click="refresh()">Atualizar lista</Button>
      </StaleNotice>
      <div class="panel farm-field">
        <label for="members-farm">Farm</label>
        <select
          id="members-farm"
          ref="farmSelect"
          v-model="farmId"
          :disabled="pending || loading || farms.length === 0"
        >
          <option
            v-for="(farm, index) in farms"
            :key="farm.farmId"
            :value="farm.farmId"
          >
            Farm {{ index + 1 }} · {{ farm.farmId }}
          </option>
        </select>
      </div>
      <div v-if="loading" aria-busy="true" class="loading panel">
        <p role="status">{{ pendingStatus('load') }}</p>
        <Skeleton /><Skeleton /><Skeleton />
      </div>
      <template v-else-if="!loadFailed">
        <MembersList
          :members="members"
          :pending="pending"
          @change-role="onChangeRole"
          @remove="onRemove"
        />
        <InvitesList
          :invites="visibleInvites"
          :pending="pending"
          @revoke="onRevoke"
        />
      </template>
    </div>
    <MembersConfirmDialog
      v-model:confirmed="confirmChecked"
      :target="confirmTarget"
      :pending="pending"
      :status="confirmStatus"
      :error="dialogError"
      @confirm="runConfirmed"
      @cancel="closeConfirm"
    />
    <p class="back"><NuxtLink to="/">Voltar ao início</NuxtLink></p>
  </main>
</template>

<style scoped>
.members-page {
  display: grid;
  gap: var(--space-4);
  align-content: start;
}
.page-header {
  display: grid;
  gap: var(--space-2);
}
.page-header h1,
.page-header p,
.back {
  margin: 0;
}
.eyebrow {
  font-size: var(--font-size-sm);
  letter-spacing: 0.04em;
  color: var(--color-text-muted);
}
.intro {
  color: var(--color-text-muted);
}
.content {
  display: grid;
  gap: var(--space-4);
  min-width: 0;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
  align-items: center;
}
[role='alert']:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
  border-radius: var(--radius-md);
}
.live:empty {
  display: none;
}
.notice {
  margin: 0;
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-inline-start: 3px solid var(--color-accent);
  border-radius: var(--radius-sm);
  background: var(--color-surface-raised);
}
.panel {
  margin: 0;
  padding: var(--space-5);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  min-width: 0;
}
.panel p {
  margin: 0;
}
.loading {
  display: grid;
  gap: var(--space-3);
}
.loading :deep(.skeleton) {
  min-block-size: 3rem;
}
.farm-field {
  display: grid;
  gap: var(--space-2);
}
label {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
}
select {
  width: 100%;
  max-width: 32rem;
  min-height: 2.75rem;
  padding: var(--space-2) var(--space-3);
  font: inherit;
  color: inherit;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}
select:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
}
select:disabled {
  opacity: 0.6;
}
/* Same bordered surface as the panels. */
.members-page :deep(.ui-card) {
  border: 1px solid var(--color-border);
  box-shadow: none;
}
@media (max-width: 30rem) {
  .panel {
    padding: var(--space-4);
  }
}
</style>
