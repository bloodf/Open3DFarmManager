<template>
  <div>
    <nav aria-label="Navegação principal">
      <NuxtLink to="/farm">Farm</NuxtLink>
      <NuxtLink to="/arquivos">Arquivos</NuxtLink>
    </nav>
    <slot />
  </div>
</template>
<style scoped>
nav {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  padding: 1rem;
}
a {
  display: inline-flex;
  align-items: center;
  min-height: 2.75rem;
}
a:focus-visible {
  outline: 3px solid currentColor;
  outline-offset: 3px;
}
</style>
