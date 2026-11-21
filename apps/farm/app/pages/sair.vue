<script setup lang="ts">
import AuthAlert from '../components/auth/AuthAlert.vue'
import AuthHeader from '../components/auth/AuthHeader.vue'
import AuthPanel from '../components/auth/AuthPanel.vue'
import AuthStatus from '../components/auth/AuthStatus.vue'
import AuthSubmit from '../components/auth/AuthSubmit.vue'
import { completeAuth } from '../utils/auth-invalidation.ts'

const pending = ref(false)
const errorMessage = ref('')
const errorSummary = ref<{ focus: () => void } | null>(null)
const allSessions = ref(false)

async function logout() {
  if (pending.value) return
  pending.value = true
  errorMessage.value = ''
  try {
    await completeAuth(() =>
      $fetch(
        allSessions.value ? '/api/auth/sessions/revoke' : '/api/auth/logout',
        {
          method: 'POST',
          body: {},
          retry: 0,
          timeout: 15_000,
        },
      ),
    )
    await navigateTo('/')
  } catch {
    errorMessage.value = allSessions.value
      ? 'Não foi possível encerrar todas as sessões. Tente novamente.'
      : 'Não foi possível sair agora. Tente novamente. Sua sessão pode continuar ativa.'
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
  <main id="conteudo" class="auth-page">
    <AuthHeader eyebrow="Open3DFarmManager" title="Sair da conta">
      Encerre sua sessão neste navegador ou em todos os dispositivos da conta.
    </AuthHeader>
    <AuthPanel
      tag="form"
      method="post"
      action="/api/auth/logout"
      :aria-busy="pending"
      @submit.prevent="logout"
    >
      <AuthAlert ref="errorSummary" :message="errorMessage" />
      <div class="choice">
        <AuthSubmit :disabled="pending" @click="allSessions = false">
          {{
            pending
              ? allSessions
                ? 'Encerrando sessões…'
                : 'Saindo…'
              : 'Sair da conta'
          }}
        </AuthSubmit>
        <p class="help">Encerra só a sessão deste navegador.</p>
      </div>
      <div class="choice">
        <AuthSubmit
          variant="secondary"
          :disabled="pending"
          @click="allSessions = true"
        >
          {{ pending ? 'Aguarde…' : 'Sair de todos os dispositivos' }}
        </AuthSubmit>
        <p class="help">
          Útil se você perdeu um aparelho ou deixou a conta aberta em outro
          lugar.
        </p>
      </div>
      <AuthStatus :message="pending ? 'Encerrando sua sessão.' : ''" />
    </AuthPanel>
    <p class="links"><NuxtLink to="/">Voltar ao início</NuxtLink></p>
  </main>
</template>

<style scoped>
.auth-page {
  display: grid;
  gap: var(--space-4);
  align-content: start;
  max-width: 30rem;
}
.choice {
  display: grid;
  gap: var(--space-2);
}
.help {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}
.links {
  margin: 0;
}
.links a {
  display: inline-flex;
  align-items: center;
  min-height: 2.75rem;
}
</style>
