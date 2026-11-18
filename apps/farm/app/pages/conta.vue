<script setup lang="ts">
const currentPassword = ref('')
const newPassword = ref('')
const pending = ref(false)
const message = ref('')
const error = ref(false)
const summary = ref<HTMLElement | null>(null)
const bambuCloudEnabled = ref(false)

async function changePassword() {
  if (pending.value) return
  pending.value = true
  message.value = ''
  error.value = false
  try {
    await $fetch('/api/auth/password', {
      method: 'POST',
      body: {
        currentPassword: currentPassword.value,
        newPassword: newPassword.value,
      },
      retry: 0,
      timeout: 15_000,
    })
    message.value = 'Senha alterada. As outras sessões foram encerradas.'
  } catch (cause: unknown) {
    const status =
      cause && typeof cause === 'object' && 'statusCode' in cause
        ? cause.statusCode
        : undefined
    message.value =
      status === 401
        ? 'Não foi possível alterar a senha. Confira a senha atual e tente novamente.'
        : status === 400
          ? 'Use uma nova senha com 12 caracteres ou mais.'
          : status === 429
            ? 'Muitas tentativas. Aguarde um pouco e tente novamente.'
            : 'Não foi possível alterar a senha agora.'
    error.value = true
  } finally {
    currentPassword.value = ''
    newPassword.value = ''
    pending.value = false
    await nextTick()
    summary.value?.focus()
  }
}
</script>

<template>
  <main id="conteudo">
    <small>Open3DFarmManager</small>
    <h1>Conta</h1>
    <h2>Alterar senha</h2>
    <form
      method="post"
      action="/api/auth/password"
      :aria-busy="pending"
      @submit.prevent="changePassword"
    >
      <label for="current-password">Senha atual</label>
      <input
        id="current-password"
        v-model="currentPassword"
        type="password"
        autocomplete="current-password"
        required
        :disabled="pending"
      />
      <label for="new-password">Nova senha</label>
      <input
        id="new-password"
        v-model="newPassword"
        type="password"
        autocomplete="new-password"
        required
        minlength="12"
        aria-describedby="new-password-help"
        :disabled="pending"
      />
      <p id="new-password-help" class="help">Use 12 caracteres ou mais.</p>
      <p ref="summary" :role="error ? 'alert' : 'status'" tabindex="-1">
        {{ message }}
      </p>
      <button type="submit" :disabled="pending">
        {{ pending ? 'Alterando…' : 'Alterar senha' }}
      </button>
    </form>
    <section
      v-if="bambuCloudEnabled"
      id="bambu-cloud-account"
      aria-labelledby="bambu-cloud-heading"
    >
      <h2 id="bambu-cloud-heading">Conta Bambu Cloud</h2>
    </section>
    <p><NuxtLink to="/sair">Sair</NuxtLink></p>
  </main>
</template>

<style scoped>
label {
  display: block;
  margin-top: 1rem;
  font-weight: 600;
}
input {
  display: block;
  width: 100%;
  max-width: 26rem;
  margin-top: 0.5rem;
  padding: 0.75rem;
  font: inherit;
}
button {
  min-height: 2.75rem;
  padding: 0.65rem 1.25rem;
  font: inherit;
  cursor: pointer;
}
button:focus-visible,
input:focus-visible {
  outline: 3px solid currentColor;
  outline-offset: 3px;
}
</style>
