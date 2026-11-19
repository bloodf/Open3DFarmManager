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

const visibleInvites = computed(() => pendingInvites(invites.value))

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
  <main id="conteudo">
    <h1>Membros e convites</h1>
    <p>
      Gerencie quem participa desta farm e revogue convites pendentes. Cada
      alteração de papel, remoção ou revogação exige confirmação.
    </p>
    <p>
      <NuxtLink to="/convites">Criar novo convite</NuxtLink>
    </p>
    <div v-if="errorMessage" ref="errorSummary" role="alert" tabindex="-1">
      <ErrorState
        v-if="loadFailed"
        title="Membros indisponíveis"
        :description="errorMessage"
      >
        <Button @click="farmId ? refresh() : start()">Tentar novamente</Button>
      </ErrorState>
      <p v-else>{{ errorMessage }}</p>
    </div>
    <p role="status" aria-live="polite">{{ loading ? '' : statusMessage }}</p>
    <div v-if="loading" aria-busy="true">
      <p role="status">{{ pendingStatus('load') }}</p>
      <Skeleton /><Skeleton /><Skeleton />
    </div>
    <EmptyState
      v-else-if="!loadFailed && !farms.length"
      title="Nenhuma farm disponível"
      description="Sua conta ainda não tem uma farm para gerenciar. Crie ou peça acesso a uma farm e volte a esta página."
    >
      <NuxtLink to="/farm">Abrir a página da farm</NuxtLink>
    </EmptyState>
    <div v-else-if="farms.length" :aria-busy="pending">
      <StaleNotice
        v-if="stale"
        title="Lista desatualizada"
        description="A alteração foi salva, mas não foi possível atualizar a lista. Os dados abaixo podem estar antigos."
      >
        <Button :disabled="pending" @click="refresh()">Atualizar lista</Button>
      </StaleNotice>
      <label for="members-farm">Farm</label>
      <select
        id="members-farm"
        v-model="farmId"
        :disabled="pending || farms.length === 0"
      >
        <option v-for="farm in farms" :key="farm.farmId" :value="farm.farmId">
          {{ farm.farmId }}
        </option>
      </select>
      <template v-if="!loadFailed">
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
      @confirm="runConfirmed"
      @cancel="closeConfirm"
    />
    <p><NuxtLink to="/">Voltar ao início</NuxtLink></p>
  </main>
</template>

<style scoped>
main {
  max-width: 48rem;
  margin: 2rem auto;
  padding: 0 1rem;
  line-height: 1.6;
}
label,
select {
  display: block;
  font: inherit;
}
label {
  margin-top: 1rem;
  font-weight: 600;
}
select {
  width: 100%;
  max-width: 28rem;
  margin-top: 0.5rem;
  min-height: 2.75rem;
  padding: 0.5rem 0.75rem;
}
select:focus-visible,
a:focus-visible {
  outline: 3px solid currentColor;
  outline-offset: 3px;
}
[role='alert'],
[role='status'] {
  min-height: 1.5rem;
}
</style>
