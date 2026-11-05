<script setup lang="ts">
const username = ref('')
const password = ref('')
const pending = ref(false)
const errorMessage = ref('')

async function login() {
  if (pending.value) return
  pending.value = true
  errorMessage.value = ''
  try {
    await $fetch('/api/auth/login', {
      method: 'POST',
      body: { username: username.value, password: password.value },
      retry: 0,
      timeout: 15_000,
    })
    password.value = ''
    await navigateTo('/')
  } catch (error: unknown) {
    const status =
      error && typeof error === 'object' && 'statusCode' in error
        ? error.statusCode
        : undefined
    errorMessage.value =
      status === 401
        ? 'Usuário ou senha inválidos. Confira os dados e tente novamente.'
        : status === 429
          ? 'Muitas tentativas. Aguarde um pouco antes de tentar novamente.'
          : 'Não foi possível entrar agora. Tente novamente mais tarde.'
  } finally {
    password.value = ''
    pending.value = false
  }
}
</script>

<template>
  <main id="conteudo">
    <small>Open3DFarmManager</small>
    <h1>Entrar</h1>
    <p>Use sua conta do Open3DFarmManager.</p>
    <form
      method="post"
      action="/api/auth/login"
      :aria-busy="pending"
      @submit.prevent="login"
    >
      <label for="username">Usuário</label>
      <input
        id="username"
        v-model="username"
        name="username"
        autocomplete="username"
        autocapitalize="none"
        :spellcheck="false"
        required
        minlength="3"
        maxlength="64"
        pattern="[a-z0-9_\-]{3,64}"
        aria-describedby="username-help"
        :disabled="pending"
      />
      <p id="username-help">
        Use letras minúsculas, números, hífen ou sublinhado.
      </p>
      <label for="password">Senha</label>
      <input
        id="password"
        v-model="password"
        name="password"
        type="password"
        autocomplete="current-password"
        required
        :disabled="pending"
      />
      <p role="alert">{{ errorMessage }}</p>
      <button type="submit" :disabled="pending">
        {{ pending ? 'Entrando…' : 'Entrar' }}
      </button>
      <p role="status">{{ pending ? 'Verificando seus dados.' : '' }}</p>
    </form>
    <p><NuxtLink to="/">Voltar ao início</NuxtLink></p>
  </main>
</template>

<style scoped>
form {
  max-width: 26rem;
}
label {
  display: block;
  font-weight: 600;
  margin-top: 1rem;
}
input {
  display: block;
  width: 100%;
  margin-top: 0.5rem;
  padding: 0.75rem;
  border: 1px solid currentColor;
  border-radius: 0.25rem;
  font: inherit;
}
button {
  min-height: 2.75rem;
  padding: 0.65rem 1.25rem;
  font: inherit;
  cursor: pointer;
}
button:disabled {
  cursor: wait;
}
input:focus-visible,
button:focus-visible {
  outline: 3px solid currentColor;
  outline-offset: 3px;
}
#username-help {
  font-size: 0.875rem;
}
</style>
