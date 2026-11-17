<script setup lang="ts">
const hydrated = ref(false)
const username = ref('')
const password = ref('')
const token = ref('')
const pending = ref(false)
const message = ref('')
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
    message.value =
      'Não foi possível redefinir a senha. O link pode ter expirado ou já ter sido usado. Peça um novo link ao proprietário da farm.'
  } finally {
    password.value = ''
    pending.value = false
  }
}
</script>

<template>
  <main id="conteudo">
    <h1>Redefinir senha</h1>
    <p>
      Esqueceu a senha? Peça ao proprietário da farm um link de redefinição. O
      link vale por 15 minutos e pode ser usado uma única vez. Ao redefinir,
      todas as sessões abertas da conta são encerradas.
    </p>
    <form :aria-busy="pending" @submit.prevent="submit()">
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
      <label for="reset-token">Código de redefinição</label>
      <p id="reset-token-hint">
        Preenchido automaticamente ao abrir o link recebido.
      </p>
      <input
        id="reset-token"
        v-model="token"
        aria-describedby="reset-token-hint"
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
        minlength="12"
        :disabled="pending"
      />
      <button type="submit" :disabled="pending || !hydrated">
        Redefinir senha
      </button>
      <p v-if="!hydrated" role="status">Preparando o formulário</p>
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
#reset-token-hint {
  margin: 0.25rem 0;
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
