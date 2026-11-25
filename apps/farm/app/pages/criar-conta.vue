<script setup lang="ts">
import AccountForm from '../components/onboarding/AccountForm.vue'
import OnboardingPage from '../components/onboarding/OnboardingPage.vue'
</script>

<template>
  <OnboardingPage title="Criar conta" access narrow>
    <template #intro>
      <p>
        Use o convite enviado por um proprietário da farm. Cada convite funciona
        uma única vez e expira em até 72 horas.
      </p>
    </template>
    <AccountForm
      endpoint="/api/auth/register"
      token-header="x-invite-token"
      token-label="Código do convite"
      token-help="Cole o código recebido, ou abra o link completo do convite."
      submit-label="Criar conta"
      token-from-fragment
    />
    <p class="alt"><NuxtLink to="/entrar">Já tenho conta</NuxtLink></p>
  </OnboardingPage>
</template>

<style scoped>
.alt {
  margin: 0;
  padding-block-start: var(--ops-space-2);
  border-block-start: 1px solid var(--ops-border);
}
.alt a {
  display: inline-flex;
  align-items: center;
  min-height: 2.75rem;
}
</style>
