<template>
  <main id="conteudo">
    <small>Open3DFarmManager</small>
    <h1>Primeiro acesso</h1>
    <p>
      Crie a conta de proprietário desta instalação. Só funciona enquanto não
      existir nenhuma conta e exige o código de configuração definido por quem
      instalou o serviço.
    </p>
    <AccountCreateForm
      endpoint="/api/auth/bootstrap"
      token-header="x-bootstrap-token"
      token-label="Código de configuração"
      token-help="Fornecido por quem instalou o serviço."
      submit-label="Criar conta de proprietário"
    />
    <p><NuxtLink to="/entrar">Já tenho conta</NuxtLink></p>
  </main>
</template>
