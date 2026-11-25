<script setup lang="ts">
import { useFarmSelection } from '../composables/useFarmRoute.ts'
import { fetchFarmMemberships } from '../composables/useFarmMemberships.ts'
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
const farmId = useFarmSelection(farms)
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
let loadingMemberships = true
let scopeGeneration = 0

const visibleInvites = computed(() => pendingInvites(invites.value))
// A failed action keeps the confirmation open, so its message belongs there;
// everything else is announced by the page-level alert.
const dialogError = computed(() =>
  confirmTarget.value && !loadFailed.value ? errorMessage.value : '',
)
const pageError = computed(() =>
  confirmTarget.value && !loadFailed.value ? '' : errorMessage.value,
)

async function loadDirectory(selected: string, generation = scopeGeneration) {
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
  if (generation !== scopeGeneration) return
  members.value = memberPage.members
  invites.value = invitePage.invites
}

async function refresh() {
  const selected = farmId.value
  const generation = scopeGeneration
  if (!selected) {
    members.value = []
    invites.value = []
    loading.value = false
    return
  }
  loading.value = true
  errorMessage.value = ''
  loadFailed.value = false
  stale.value = false
  statusMessage.value = pendingStatus('load')
  try {
    await loadDirectory(selected, generation)
    if (generation === scopeGeneration) statusMessage.value = ''
  } catch (error: unknown) {
    if (generation !== scopeGeneration) return
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
    if (generation === scopeGeneration) loading.value = false
  }
}

async function start() {
  loadingMemberships = true
  loading.value = true
  errorMessage.value = ''
  loadFailed.value = false
  try {
    farms.value = await fetchFarmMemberships<Farm>({ timeout: 15_000 })
    loadingMemberships = false
    if (farmId.value) await refresh()
    else loading.value = false
  } catch (error: unknown) {
    loadingMemberships = false
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

watch(
  farmId,
  async () => {
    const generation = ++scopeGeneration
    confirmTarget.value = null
    confirmChecked.value = false
    confirmStatus.value = ''
    members.value = []
    invites.value = []
    if (loadingMemberships) return
    // The field is disabled while the lists load, which drops keyboard focus.
    const hadFocus = document.activeElement === farmSelect.value
    await refresh()
    if (hadFocus && generation === scopeGeneration && !loadFailed.value) {
      await nextTick()
      farmSelect.value?.focus()
    }
  },
  { flush: 'sync' },
)

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
  const selected = farmId.value
  if (!target || !confirmChecked.value || pending.value || !selected) return
  const generation = scopeGeneration
  pending.value = true
  errorMessage.value = ''
  statusMessage.value = pendingStatus(target.kind)
  confirmStatus.value = pendingStatus(target.kind)
  let restoreFocus = false
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
    if (generation !== scopeGeneration) return
    statusMessage.value = successMessage(target.kind)
    confirmTarget.value = null
    confirmChecked.value = false
    confirmStatus.value = ''
    try {
      await loadDirectory(selected, generation)
      if (generation === scopeGeneration) stale.value = false
    } catch {
      if (generation === scopeGeneration) stale.value = true
    }
    restoreFocus = generation === scopeGeneration
  } catch (error: unknown) {
    if (generation !== scopeGeneration) return
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
  // The row that opened the dialog may be gone, and its buttons were disabled
  // while the request ran: keep keyboard focus on the page.
  if (restoreFocus) {
    await nextTick()
    if (!document.activeElement || document.activeElement === document.body)
      farmSelect.value?.focus()
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
  <main id="conteudo" class="ops-account members-page">
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
          <option disabled value="">Selecione uma farm</option>
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
      <template v-else-if="farmId && !loadFailed">
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
.content {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--ops-space-3);
  min-width: 0;
}
.live:empty {
  display: none;
}
.loading :deep(.skeleton) {
  min-block-size: 3rem;
}
#conteudo div.farm-field.panel {
  gap: var(--space-1);
}
</style>
