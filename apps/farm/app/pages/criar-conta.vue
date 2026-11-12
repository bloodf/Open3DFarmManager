<template>
  <main id="conteudo">
    <small>Open3DFarmManager</small>
    <h1>Criar conta</h1>
    <p>
      Use o convite enviado por um proprietário da farm. Cada convite funciona
      uma única vez e expira em até 72 horas.
    </p>
    <AccountCreateForm
      endpoint="/api/auth/register"
      token-header="x-invite-token"
      token-label="Código do convite"
      token-help="Cole o código recebido, ou abra o link completo do convite."
      submit-label="Criar conta"
      token-from-fragment
    />
    <p><NuxtLink to="/entrar">Já tenho conta</NuxtLink></p>
  </main>
</template>
