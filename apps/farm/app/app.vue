<template>
  <NuxtRouteAnnouncer />
  <NuxtLayout :name="$route.path === '/painel' ? 'default' : undefined">
    <NuxtPage />
  </NuxtLayout>
</template>

<style>
.shell .kiosk-root {
  position: static;
  min-height: 70vh;
}
</style>
