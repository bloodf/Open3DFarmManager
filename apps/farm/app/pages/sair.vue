<script setup lang="ts">
import { completeAuth } from '../utils/auth-invalidation.ts'

const pending = ref(false)
const errorMessage = ref('')
const errorSummary = ref<HTMLElement | null>(null)

async function logout() {
  if (pending.value) return
  pending.value = true
  errorMessage.value = ''
  try {
    await completeAuth(() =>
      $fetch('/api/auth/logout', {
        method: 'POST',
        body: {},
        retry: 0,
        timeout: 15_000,
      }),
    )
    await navigateTo('/')
  } catch {
    errorMessage.value =
      'Não foi possível sair agora. Tente novamente. Sua sessão pode continuar ativa.'
  } finally {
    pending.value = false
    if (errorMessage.value) {
      await nextTick()
      errorSummary.value?.focus()
    }
  }
}
</script>

<template>
  <main id="conteudo">
    <small>Open3DFarmManager</small>
    <h1>Sair da conta</h1>
    <p>Encerre sua sessão neste navegador.</p>
    <form
      method="post"
      action="/api/auth/logout"
      :aria-busy="pending"
      @submit.prevent="logout"
    >
      <p ref="errorSummary" role="alert" tabindex="-1">{{ errorMessage }}</p>
      <button type="submit" :disabled="pending">
        {{ pending ? 'Saindo…' : 'Sair da conta' }}
      </button>
      <p role="status">{{ pending ? 'Encerrando sua sessão.' : '' }}</p>
    </form>
    <p><NuxtLink to="/">Voltar ao início</NuxtLink></p>
  </main>
</template>

<style scoped>
button {
  min-height: 2.75rem;
  padding: 0.65rem 1.25rem;
  font: inherit;
  cursor: pointer;
}
button:disabled {
  cursor: wait;
}
button:focus-visible {
  outline: 3px solid currentColor;
  outline-offset: 3px;
}
</style>
