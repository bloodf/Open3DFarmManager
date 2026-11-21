<script setup lang="ts">
import AccountForm from '../components/onboarding/AccountForm.vue'
import OnboardingPage from '../components/onboarding/OnboardingPage.vue'
</script>

<template>
  <OnboardingPage title="Primeiro acesso" narrow>
    <template #intro>
      <p>
        Crie a conta de proprietário desta instalação. Só funciona enquanto não
        existir nenhuma conta e exige o código de configuração definido por
        quem instalou o serviço.
      </p>
    </template>
    <AccountForm
      endpoint="/api/auth/bootstrap"
      token-header="x-bootstrap-token"
      token-label="Código de configuração"
      token-help="Fornecido por quem instalou o serviço."
      submit-label="Criar conta de proprietário"
      secret-token
    />
    <p class="alt"><NuxtLink to="/entrar">Já tenho conta</NuxtLink></p>
  </OnboardingPage>
</template>

<style scoped>
.alt {
  margin: 0;
}
</style>
