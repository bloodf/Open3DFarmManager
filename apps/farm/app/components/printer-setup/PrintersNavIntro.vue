<script setup lang="ts">
defineOptions({ name: 'PrintersNavIntro' })
</script>

<template>
  <p>
    <NuxtLink to="/compatibilidade"
      >Consultar compatibilidade de impressoras</NuxtLink
    >
  </p>
  <nav aria-label="Conta">
    <NuxtLink to="/">Início</NuxtLink> ·
    <NuxtLink to="/farm">Minha farm</NuxtLink> ·
    <NuxtLink to="/connectors">Connectors</NuxtLink> ·
    <NuxtLink to="/parear">Aprovar Connector</NuxtLink> ·
    <NuxtLink to="/dispositivos">Dispositivos do navegador</NuxtLink> ·
    <NuxtLink to="/sair">Sair da conta</NuxtLink>
  </nav>
  <p>
    Consulte as atribuições de impressoras. Sem conexão direta com o Connector,
    o modo degradado é somente leitura para operação: esta página não envia
    comandos de impressão nem acessa câmeras.
  </p>
</template>
