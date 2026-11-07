<script setup lang="ts">
const username = ref('')
const password = ref('')
const token = ref('')
const pending = ref(false)
const message = ref('')
async function submit(complete: boolean) {
  if (pending.value) return
  pending.value = true
  message.value = ''
  try {
    const result = await $fetch<{ message: string }>(
      complete
        ? '/api/auth/password-reset-complete'
        : '/api/auth/password-reset-request',
      {
        method: 'POST',
        headers: complete ? { 'x-password-reset-token': token.value } : {},
        body: {
          username: username.value,
          password: complete ? password.value : 'reset-request',
        },
      },
    )
    message.value = result.message
  } catch {
    message.value =
      'Não foi possível concluir a solicitação. Verifique o código ou tente novamente mais tarde.'
  } finally {
    password.value = ''
    token.value = ''
    pending.value = false
  }
}
</script>

<template>
  <main id="conteudo">
    <h1>Redefinir senha</h1>
    <p>
      Solicite instruções pelo canal cadastrado ou informe o código recebido.
    </p>
    <form :aria-busy="pending" @submit.prevent="submit(true)">
      <label for="reset-username">Usuário</label>
      <input
        id="reset-username"
        v-model="username"
        autocomplete="username"
        autocapitalize="none"
        :spellcheck="false"
        required
        minlength="3"
        maxlength="64"
        pattern="[a-z0-9_\-]{3,64}"
        :disabled="pending"
      />
      <button
        type="button"
        :disabled="pending || !username"
        @click="submit(false)"
      >
        Solicitar instruções
      </button>
      <label for="reset-token">Código de redefinição</label>
      <input
        id="reset-token"
        v-model="token"
        autocomplete="off"
        autocapitalize="none"
        :spellcheck="false"
        required
        minlength="43"
        maxlength="43"
        :disabled="pending"
      />
      <label for="reset-password">Nova senha</label>
      <input
        id="reset-password"
        v-model="password"
        type="password"
        autocomplete="new-password"
        required
        :disabled="pending"
      />
      <button type="submit" :disabled="pending">Redefinir senha</button>
      <p role="status" aria-live="polite">
        {{ pending ? 'Processando solicitação.' : message }}
      </p>
    </form>
    <NuxtLink to="/entrar">Voltar para entrar</NuxtLink>
  </main>
</template>

<style scoped>
form {
  max-width: 26rem;
}
label {
  display: block;
  margin-top: 1rem;
  font-weight: 600;
}
input {
  display: block;
  width: 100%;
  padding: 0.75rem;
  font: inherit;
}
button {
  min-height: 2.75rem;
  margin-top: 0.75rem;
  font: inherit;
}
input:focus-visible,
button:focus-visible {
  outline: 3px solid currentColor;
  outline-offset: 3px;
}
</style>
