<script setup lang="ts">
type Farm = { farmId: string }
const roles = [
  { value: 'viewer', label: 'Visualizador' },
  { value: 'operator', label: 'Operador' },
  { value: 'admin', label: 'Administrador' },
]
const farms = ref<Farm[]>([])
const farmId = ref('')
const role = ref('viewer')
const loading = ref(true)
const pending = ref(false)
const errorMessage = ref('')
const link = ref('')
const expiresAt = ref('')
const errorSummary = ref<HTMLElement | null>(null)

onMounted(async () => {
  try {
    const page = await $fetch<{ farms: Farm[] }>('/api/farms', {
      query: { limit: 50 },
      retry: 0,
      timeout: 15_000,
    })
    farms.value = page.farms
    farmId.value = page.farms[0]?.farmId ?? ''
  } catch {
    errorMessage.value = 'Entre na sua conta para criar convites.'
  } finally {
    loading.value = false
  }
})

async function submit() {
  if (pending.value || !farmId.value) return
  pending.value = true
  errorMessage.value = ''
  link.value = ''
  try {
    const result = await $fetch<{ token: string; expiresAt: string }>(
      `/api/farms/${farmId.value}/invites`,
      {
        method: 'POST',
        body: { role: role.value },
        retry: 0,
        timeout: 15_000,
      },
    )
    link.value = `${window.location.origin}/criar-conta#codigo=${result.token}`
    expiresAt.value = new Date(result.expiresAt).toLocaleString('pt-BR')
  } catch (error: unknown) {
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
  <main id="conteudo">
    <h1>Convidar pessoa</h1>
    <p>
      Gere um link de uso único, válido por 72 horas. Envie-o por um canal
      confiável: quem tiver o link poderá criar uma conta com o papel escolhido.
    </p>
    <p v-if="loading" role="status">Carregando suas farms…</p>
    <form
      v-else
      class="account-form"
      :aria-busy="pending"
      @submit.prevent="submit"
    >
      <label for="invite-farm">Farm</label>
      <select id="invite-farm" v-model="farmId" required :disabled="pending">
        <option v-for="farm in farms" :key="farm.farmId" :value="farm.farmId">
          {{ farm.farmId }}
        </option>
      </select>
      <label for="invite-role">Papel</label>
      <select id="invite-role" v-model="role" required :disabled="pending">
        <option v-for="item in roles" :key="item.value" :value="item.value">
          {{ item.label }}
        </option>
      </select>
      <p ref="errorSummary" role="alert" tabindex="-1">{{ errorMessage }}</p>
      <button type="submit" :disabled="pending || !farmId">
        {{ pending ? 'Criando convite…' : 'Criar convite' }}
      </button>
    </form>
    <section v-if="link" aria-labelledby="invite-result">
      <h2 id="invite-result">Convite criado</h2>
      <p>Este link aparece uma única vez. Expira em {{ expiresAt }}.</p>
      <label for="invite-link">Link do convite</label>
      <input
        id="invite-link"
        :value="link"
        readonly
        @focus="(e) => (e.target as HTMLInputElement).select()"
      />
    </section>
    <p><NuxtLink to="/">Voltar ao início</NuxtLink></p>
  </main>
</template>
