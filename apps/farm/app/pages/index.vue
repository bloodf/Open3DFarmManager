<script setup lang="ts">
const heading = ref<HTMLElement | null>(null)

onMounted(() => heading.value?.focus())
</script>

<template>
  <main id="conteudo">
    <small>Open3DFarmManager · Desenvolvimento</small>
    <h1 ref="heading" tabindex="-1">Sua farm de impressão, em um só lugar.</h1>
    <nav aria-label="Conta">
      <NuxtLink to="/connectors">Consultar Connectors</NuxtLink>
      <NuxtLink to="/parear">Aprovar Connector</NuxtLink>
      <NuxtLink to="/entrar">Entrar</NuxtLink>
      <NuxtLink to="/sair">Sair da conta</NuxtLink>
    </nav>
    <section aria-labelledby="disponibilidade">
      <h2 id="disponibilidade">Recursos ainda indisponíveis</h2>
      <p>
        A conexão com Klipper, Moonraker e Spoolman está em desenvolvimento. O
        pareamento de um Connector depende da configuração segura do serviço e
        da aprovação de um proprietário ou administrador da farm.
      </p>
      <p>
        O estado das impressoras e as câmeras ainda não estão disponíveis. Sem
        conexão, o modo degradado será somente leitura; comandos não estarão
        disponíveis.
      </p>
    </section>
    <p>
      <a href="https://github.com/bloodf/Open3DFarmManager"
        >Acompanhar o desenvolvimento no GitHub</a
      >
    </p>
  </main>
</template>

<style scoped>
nav {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  margin: 1.5rem 0 2rem;
}

h1:focus-visible {
  outline: 3px solid currentColor;
  outline-offset: 4px;
}
</style>
