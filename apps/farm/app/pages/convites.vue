<script setup lang="ts">
import { useFarmSelection } from '../composables/useFarmRoute.ts'
import { fetchFarmMemberships } from '../composables/useFarmMemberships.ts'
import { formatDateTime } from '../utils/ui-format.ts'
import Button from '../components/ui/Button.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import ErrorState from '../components/ui/ErrorState.vue'
import Field from '../components/ui/Field.vue'
import Skeleton from '../components/ui/Skeleton.vue'
type Farm = { farmId: string }
const roles = [
  { value: 'viewer', label: 'Visualizador' },
  { value: 'operator', label: 'Operador' },
  { value: 'admin', label: 'Administrador' },
]
const farms = ref<Farm[]>([])
const farmId = useFarmSelection(farms)
const role = ref('viewer')
const loading = ref(true)
const pending = ref(false)
const errorMessage = ref('')
const loadFailed = ref(false)
const link = ref('')
const expiresAt = ref('')
const errorSummary = ref<HTMLElement | null>(null)
const resultHeading = ref<HTMLElement | null>(null)

async function loadFarms() {
  loading.value = true
  loadFailed.value = false
  errorMessage.value = ''
  try {
    farms.value = await fetchFarmMemberships<Farm>({ timeout: 15_000 })
  } catch {
    loadFailed.value = true
    errorMessage.value = 'Entre na sua conta para criar convites.'
  } finally {
    loading.value = false
  }
  if (loadFailed.value) {
    await nextTick()
    errorSummary.value?.focus()
  }
}
onMounted(loadFarms)
let scopeGeneration = 0
watch(farmId, () => {
  scopeGeneration++
  link.value = ''
  expiresAt.value = ''
})

async function submit() {
  const selected = farmId.value
  if (pending.value || !selected) return
  const generation = scopeGeneration
  pending.value = true
  errorMessage.value = ''
  link.value = ''
  try {
    const result = await $fetch<{ token: string; expiresAt: string }>(
      `/api/farms/${selected}/invites`,
      {
        method: 'POST',
        body: { role: role.value },
        retry: 0,
        timeout: 15_000,
      },
    )
    if (generation !== scopeGeneration) return
    link.value = `${window.location.origin}/criar-conta#codigo=${result.token}`
    expiresAt.value = formatDateTime(result.expiresAt) ?? ''
    // The link is shown once: move keyboard and screen-reader focus to it.
    await nextTick()
    resultHeading.value?.focus()
  } catch (error: unknown) {
    if (generation !== scopeGeneration) return
    const status =
      error && typeof error === 'object' && 'statusCode' in error
        ? error.statusCode
        : undefined
    errorMessage.value =
      status === 403
        ? 'Somente proprietários da farm podem criar convites.'
        : status === 429
          ? 'Muitas tentativas. Aguarde um pouco antes de tentar novamente.'
          : 'Não foi possível criar o convite agora. Tente novamente mais tarde.'
    await nextTick()
    errorSummary.value?.focus()
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <main id="conteudo" class="ops-screen invite-page">
    <header class="page-header">
      <p class="eyebrow">Open3DFarmManager</p>
      <h1>Convidar pessoa</h1>
      <p class="intro">
        Gere um link de uso único, válido por 72 horas. Envie-o por um canal
        confiável: quem tiver o link poderá criar uma conta com o papel
        escolhido.
      </p>
    </header>
    <div ref="errorSummary" class="alert" role="alert" tabindex="-1">
      <ErrorState
        v-if="errorMessage"
        :title="loadFailed ? 'Convites indisponíveis' : 'Convite não criado'"
        :description="errorMessage"
      >
        <div v-if="loadFailed" class="actions">
          <Button @click="loadFarms()">Tentar novamente</Button>
          <NuxtLink to="/entrar">Entrar na conta</NuxtLink>
        </div>
      </ErrorState>
    </div>
    <div v-if="loading" aria-busy="true" class="loading panel">
      <p role="status">Carregando suas farms…</p>
      <Skeleton /><Skeleton /><Skeleton />
    </div>
    <EmptyState
      v-else-if="!loadFailed && !farms.length"
      title="Nenhuma farm disponível"
      description="Sua conta ainda não tem uma farm para receber convites. Crie ou peça acesso a uma farm e volte a esta página."
    >
      <NuxtLink to="/farm">Abrir a página da farm</NuxtLink>
    </EmptyState>
    <form
      v-else-if="!loadFailed"
      class="panel invite-form"
      aria-labelledby="invite-form-heading"
      :aria-busy="pending"
      @submit.prevent="submit"
    >
      <h2 id="invite-form-heading">Novo convite</h2>
      <Field label="Farm" v-slot="{ control }">
        <select v-bind="control" v-model="farmId" required :disabled="pending">
          <option disabled value="">Selecione uma farm</option>
          <option
            v-for="(farm, index) in farms"
            :key="farm.farmId"
            :value="farm.farmId"
          >
            Farm {{ index + 1 }} · {{ farm.farmId }}
          </option>
        </select>
      </Field>
      <Field label="Papel" v-slot="{ control }">
        <select v-bind="control" v-model="role" required :disabled="pending">
          <option v-for="item in roles" :key="item.value" :value="item.value">
            {{ item.label }}
          </option>
        </select>
      </Field>
      <div class="actions">
        <Button type="submit" :disabled="pending || !farmId">
          {{ pending ? 'Criando convite…' : 'Criar convite' }}
        </Button>
      </div>
    </form>
    <section v-if="link" class="panel result" aria-labelledby="invite-result">
      <h2 id="invite-result" ref="resultHeading" tabindex="-1">
        Convite criado
      </h2>
      <p>Este link aparece uma única vez. Expira em {{ expiresAt }}.</p>
      <div class="link-field">
        <label for="invite-link">Link do convite</label>
        <input
          id="invite-link"
          :value="link"
          readonly
          autocomplete="off"
          spellcheck="false"
          @focus="(e) => (e.target as HTMLInputElement).select()"
        />
      </div>
    </section>
    <nav class="links" aria-label="Páginas relacionadas">
      <NuxtLink to="/membros">Gerenciar membros e convites</NuxtLink>
      <NuxtLink to="/">Voltar ao início</NuxtLink>
    </nav>
  </main>
</template>

<style scoped>
.alert:empty {
  display: none;
}
.loading :deep(.skeleton) {
  min-block-size: 3rem;
}
.link-field {
  display: grid;
  gap: var(--space-1);
}
.links {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
}
@media (min-width: 64rem) {
  #conteudo form.invite-form.panel {
    grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) auto;
    align-items: end;
  }
  .invite-form h2 {
    grid-column: 1 / -1;
  }
}
</style>
