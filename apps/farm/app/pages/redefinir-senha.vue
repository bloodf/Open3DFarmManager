<script setup lang="ts">
import AuthAlert from '../components/auth/AuthAlert.vue'
import AuthField from '../components/auth/AuthField.vue'
import AuthHeader from '../components/auth/AuthHeader.vue'
import AuthPanel from '../components/auth/AuthPanel.vue'
import AuthStatus from '../components/auth/AuthStatus.vue'
import AuthSubmit from '../components/auth/AuthSubmit.vue'

const hydrated = ref(false)
const username = ref('')
const password = ref('')
const token = ref('')
const pending = ref(false)
const message = ref('')
const failure = ref('')
const errorSummary = ref<{ focus: () => void } | null>(null)
const formStatus = computed(() =>
  !hydrated.value
    ? 'Preparando o formulário'
    : pending.value
      ? 'Processando solicitação.'
      : message.value,
)
onMounted(() => {
  // The owner-issued link carries user and code in the fragment, never sent to the server.
  const fragment = new URLSearchParams(window.location.hash.slice(1))
  username.value = fragment.get('usuario') ?? ''
  token.value = fragment.get('codigo') ?? ''
  if (window.location.hash)
    history.replaceState(
      history.state,
      '',
      window.location.pathname + window.location.search,
    )
  hydrated.value = true
})
async function submit() {
  if (pending.value) return
  pending.value = true
  message.value = ''
  failure.value = ''
  try {
    const result = await $fetch<{ message: string }>(
      '/api/auth/password-reset-complete',
      {
        method: 'POST',
        headers: { 'x-password-reset-token': token.value },
        body: { username: username.value, password: password.value },
      },
    )
    message.value = result.message
    token.value = ''
  } catch {
    failure.value =
      'Não foi possível redefinir a senha. O link pode ter expirado ou já ter sido usado. Peça um novo link ao proprietário da farm.'
  } finally {
    password.value = ''
    pending.value = false
    if (failure.value) {
      await nextTick()
      errorSummary.value?.focus()
    }
  }
}
</script>

<template>
  <main id="conteudo" class="auth-page">
    <AuthHeader title="Redefinir senha">
      Esqueceu a senha? Peça ao proprietário da farm um link de redefinição. O
      link vale por 15 minutos e pode ser usado uma única vez. Ao redefinir,
      todas as sessões abertas da conta são encerradas.
    </AuthHeader>
    <AuthPanel tag="form" :aria-busy="pending" @submit.prevent="submit()">
      <AuthField
        id="reset-username"
        v-model="username"
        label="Usuário"
        autocomplete="username"
        autocapitalize="none"
        :spellcheck="false"
        required
        minlength="3"
        maxlength="64"
        pattern="[a-z0-9_\-]{3,64}"
        :disabled="pending"
      />
      <AuthField
        id="reset-token"
        v-model="token"
        label="Código de redefinição"
        hint="Preenchido automaticamente ao abrir o link recebido."
        autocomplete="off"
        autocapitalize="none"
        :spellcheck="false"
        required
        minlength="43"
        maxlength="43"
        :disabled="pending"
      />
      <AuthField
        id="reset-password"
        v-model="password"
        label="Nova senha"
        hint="Use 12 caracteres ou mais."
        type="password"
        autocomplete="new-password"
        required
        minlength="12"
        :disabled="pending"
      />
      <AuthAlert ref="errorSummary" :message="failure" />
      <AuthSubmit :disabled="pending || !hydrated">
        Redefinir senha
      </AuthSubmit>
      <AuthStatus
        :message="formStatus"
        :tone="message && !pending ? 'success' : undefined"
        aria-live="polite"
      />
    </AuthPanel>
    <p class="links"><NuxtLink to="/entrar">Voltar para entrar</NuxtLink></p>
  </main>
</template>

<style scoped>
.auth-page {
  display: grid;
  gap: var(--ops-space-4);
  align-content: start;
  max-width: 26rem;
  padding: var(--ops-space-5) var(--ops-space-4);
  font-size: var(--ops-text-body);
  line-height: 20px;
}

.links {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ops-space-2) var(--ops-space-5);
  margin: 0;
  padding-block-start: var(--ops-space-2);
  border-block-start: 1px solid var(--ops-border);
}
.links a {
  display: inline-flex;
  align-items: center;
  min-height: 2.75rem;
  color: var(--ops-action);
}
.links a:focus-visible {
  outline: var(--focus-ring-width) solid var(--ops-action);
  outline-offset: 2px;
}
</style>
